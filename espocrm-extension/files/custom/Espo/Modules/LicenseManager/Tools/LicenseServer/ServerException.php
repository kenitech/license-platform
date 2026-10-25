<?php

namespace Espo\Modules\LicenseManager\Tools\LicenseServer;

use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\Conflict;
use Espo\Core\Exceptions\Error;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Exceptions\NotFound;
use RuntimeException;
use Throwable;

/**
 * A refusal or failure reported by (or while reaching) the license server.
 * The message is shown to the user as is.
 */
class ServerException extends RuntimeException
{
    public const NOT_CONFIGURED = 'not_configured';
    public const UNAVAILABLE = 'unavailable';

    public function __construct(
        string $message,
        private string $errorCode,
        private int $httpStatus = 0,
        private array $body = [],
        ?Throwable $previous = null
    ) {
        parent::__construct($message, 0, $previous);
    }

    public static function notConfigured(): self
    {
        return new self('The license server connection is not configured', self::NOT_CONFIGURED);
    }

    public static function unavailable(string $detail = '', ?Throwable $previous = null): self
    {
        $message = 'The license server did not confirm the operation';

        if ($detail !== '') {
            $message .= ' (' . $detail . ')';
        }

        return new self($message . '. Retrying is safe.', self::UNAVAILABLE, 0, [], $previous);
    }

    public function getErrorCode(): string
    {
        return $this->errorCode;
    }

    public function getHttpStatus(): int
    {
        return $this->httpStatus;
    }

    public function getBody(): array
    {
        return $this->body;
    }

    public function isUnavailable(): bool
    {
        return $this->errorCode === self::UNAVAILABLE;
    }

    /**
     * Converts to the EspoCRM exception that shows the message to the user.
     */
    public function toEspoException(): Throwable
    {
        $message = $this->getMessage();

        if ($this->errorCode === self::NOT_CONFIGURED) {
            return new Error($message);
        }

        return match (true) {
            $this->httpStatus === 400, $this->httpStatus === 422 => new BadRequest($message),
            $this->httpStatus === 403 => new Forbidden($message),
            $this->httpStatus === 404 => new NotFound($message),
            $this->httpStatus === 409 => new Conflict($message),
            default => new Error($message),
        };
    }
}
