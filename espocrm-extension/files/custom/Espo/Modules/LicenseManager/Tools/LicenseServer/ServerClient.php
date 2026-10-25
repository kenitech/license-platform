<?php

namespace Espo\Modules\LicenseManager\Tools\LicenseServer;

use Espo\Core\Utils\Config;

/**
 * Talks to the license server admin API. Every request is signed with the
 * CRM secret (HMAC-SHA256); the secret itself never leaves this server.
 */
class ServerClient
{
    private const DEFAULT_TIMEOUT = 20;

    /** @var ?callable */
    private $transport = null;

    public function __construct(private Config $config) {}

    public function isConfigured(): bool
    {
        return $this->getServerUrl() !== '' &&
            (string) $this->config->get('licenseManagerClientId') !== '' &&
            (string) $this->config->get('licenseManagerClientSecret') !== '';
    }

    public function getServerUrl(): string
    {
        return rtrim((string) $this->config->get('licenseManagerServerUrl'), '/');
    }

    /**
     * For tests: fn(string $method, string $url, array $headers, string $body): array{0: int, 1: string}
     */
    public function setTransport(callable $transport): void
    {
        $this->transport = $transport;
    }

    public function get(string $path, array $query = []): array
    {
        return $this->request('GET', $path, $query, null);
    }

    public function post(string $path, array $body = [], ?string $idempotencyKey = null): array
    {
        return $this->request('POST', $path, [], $body, $idempotencyKey);
    }

    public function put(string $path, array $body = []): array
    {
        return $this->request('PUT', $path, [], $body);
    }

    public static function signature(string $secret, string $method, string $path, int $ts, string $nonce, string $body): string
    {
        $payload = strtoupper($method) . "\n" . $path . "\n" . $ts . "\n" . $nonce . "\n" . hash('sha256', $body);

        return rtrim(strtr(base64_encode(hash_hmac('sha256', $payload, $secret, true)), '+/', '-_'), '=');
    }

    public static function encodeSegment(string $value): string
    {
        return rawurlencode($value);
    }

    private function request(string $method, string $path, array $query, ?array $body, ?string $idempotencyKey = null): array
    {
        if (!$this->isConfigured()) {
            throw ServerException::notConfigured();
        }

        $baseUrl = $this->getServerUrl();

        if (!str_starts_with($baseUrl, 'https://')) {
            throw new ServerException(
                'The license server URL must start with https:// (licenseManagerServerUrl)',
                'invalid_configuration'
            );
        }

        $pathWithQuery = $path . ($query ? '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986) : '');
        $bodyText = $body === null ? '' : json_encode(
            (object) $body,
            JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR
        );

        $clientId = (string) $this->config->get('licenseManagerClientId');
        $secret = (string) $this->config->get('licenseManagerClientSecret');
        $ts = time();
        $nonce = bin2hex(random_bytes(16));
        $sig = self::signature($secret, $method, $pathWithQuery, $ts, $nonce, $bodyText);

        $headers = [
            'Accept: application/json',
            'Content-Type: application/json',
            "Authorization: LMP-HMAC client=$clientId, ts=$ts, nonce=$nonce, sig=$sig",
        ];

        if ($idempotencyKey !== null && $idempotencyKey !== '') {
            $headers[] = 'Idempotency-Key: ' . preg_replace('/[^A-Za-z0-9_.:-]/', '', $idempotencyKey);
        }

        [$status, $responseText] = $this->send($method, $baseUrl . $pathWithQuery, $headers, $bodyText);

        $data = json_decode($responseText, true);

        if (!is_array($data)) {
            throw ServerException::unavailable("unexpected answer, HTTP $status");
        }

        if ($status >= 200 && $status < 300) {
            return $data;
        }

        if ($status >= 500 || $status === 0) {
            throw ServerException::unavailable($data['message'] ?? "HTTP $status");
        }

        $message = (string) ($data['message'] ?? "The license server refused the request (HTTP $status)");

        throw new ServerException($message, (string) ($data['error'] ?? 'error'), $status, $data);
    }

    /**
     * @return array{0: int, 1: string}
     */
    private function send(string $method, string $url, array $headers, string $body): array
    {
        if ($this->transport) {
            return ($this->transport)($method, $url, $headers, $body);
        }

        if (!function_exists('curl_init')) {
            throw new ServerException('The PHP curl extension is required by License Manager', 'curl_missing');
        }

        $timeout = (int) ($this->config->get('licenseManagerTimeout') ?: self::DEFAULT_TIMEOUT);

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => min(10, $timeout),
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
        ]);

        if ($method !== 'GET') {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($response === false) {
            throw ServerException::unavailable($error ?: 'no response');
        }

        return [$status, (string) $response];
    }
}
