<?php

namespace Espo\Modules\LicenseManager\Tools;

use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\NotFound;
use Espo\Entities\User;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerClient;
use Espo\ORM\Entity;
use Espo\ORM\EntityManager;
use stdClass;

/**
 * Daily operations on a license (Part 5 of the guide). Every operation goes
 * to the license server first and is recorded there with the user's name.
 */
class OperationService
{
    public const OPERATIONS = [
        'suspend', 'reactivate', 'revoke', 'extend', 'renew', 'cancel-subscription',
        'replace-key', 'recover', 'release-all',
    ];

    public function __construct(
        private ServerClient $client,
        private Mirror $mirror,
        private Permission $permission,
        private EntityManager $entityManager,
        private User $user
    ) {}

    private function actor(): array
    {
        return ['id' => $this->user->getId(), 'name' => $this->user->get('name') ?: $this->user->get('userName')];
    }

    private function getLicense(string $id): Entity
    {
        $license = $this->entityManager->getEntityById('LmLicense', $id);

        if (!$license) {
            throw new NotFound('License not found');
        }

        $this->permission->assertCanRead($license);

        return $license;
    }

    private function serverPath(Entity $license, string $suffix = ''): string
    {
        return '/v1/admin/licenses/' . ServerClient::encodeSegment((string) $license->get('serverId')) . $suffix;
    }

    /**
     * @return array{key?: string, released?: int}
     */
    public function run(string $licenseId, string $operation, stdClass $data): array
    {
        $this->permission->assertCanOperate();

        if (!in_array($operation, self::OPERATIONS, true)) {
            throw new BadRequest('Unknown license operation');
        }

        $license = $this->getLicense($licenseId);
        $body = ['actor' => $this->actor()];

        foreach (['reason', 'unit', 'paymentRef'] as $name) {
            if (isset($data->$name) && $data->$name !== '') {
                $body[$name] = (string) $data->$name;
            }
        }

        foreach (['value', 'periods'] as $name) {
            if (isset($data->$name) && $data->$name !== '') {
                $body[$name] = (int) $data->$name;
            }
        }

        if (!empty($data->expiresAt)) {
            // A date picked in EspoCRM: the license works until the end of that day (UTC).
            $body['expiresAt'] = preg_match('/^\d{4}-\d{2}-\d{2}$/', $data->expiresAt) ?
                $data->expiresAt . 'T23:59:59Z' : (string) $data->expiresAt;
        }

        if ($operation === 'cancel-subscription') {
            $body['atPeriodEnd'] = !isset($data->atPeriodEnd) || (bool) $data->atPeriodEnd;
        }

        if ($operation === 'recover') {
            $body['replaceKey'] = !empty($data->replaceKey);
            $body['activationIds'] = $this->serverActivationIds((array) ($data->activationIds ?? []));
        }

        $idempotencyKey = !empty($data->requestId) ? $operation . '-' . $data->requestId : null;

        $result = $this->client->post($this->serverPath($license, '/' . $operation), $body, $idempotencyKey);

        $this->mirror->applyDetail($result);
        $this->pullAudit($license);

        $out = [];

        if (!empty($result['key'])) {
            $out['key'] = $result['key'];
            $out['keys'] = [[
                'reference' => $result['license']['reference'],
                'key' => $result['key'],
                'application' => $license->get('applicationName'),
                'plan' => $license->get('planName'),
                'customer' => $license->get('accountName'),
                'expiresAt' => $result['license']['expiresAt'] ?? null,
            ]];
        } elseif (!empty($result['replayed']) && in_array($operation, ['replace-key', 'recover'])) {
            $out['error'] = 'This operation was already done and its new key was shown then.';
        }

        if (isset($result['released'])) {
            $out['released'] = (int) $result['released'];
        }

        return $out;
    }

    private function serverActivationIds(array $ids): array
    {
        $serverIds = [];

        foreach ($ids as $id) {
            $activation = $this->entityManager->getEntityById('LmDeviceActivation', (string) $id);

            if ($activation && $activation->get('serverId')) {
                $serverIds[] = $activation->get('serverId');
            }
        }

        return $serverIds;
    }

    /**
     * "Refresh from Server": fetches the license, its devices and its audit
     * history immediately instead of waiting for the next sync.
     */
    public function refresh(string $licenseId): void
    {
        $license = $this->getLicense($licenseId);

        $this->mirror->applyDetail($this->client->get($this->serverPath($license)));
        $this->pullAudit($license);
    }

    private function pullAudit(Entity $license): void
    {
        $audit = $this->client->get($this->serverPath($license, '/audit'));

        foreach ($audit['audit'] ?? [] as $entry) {
            $this->mirror->upsertAudit($entry);
        }
    }

    /**
     * Release Device / Assisted Transfer on a device activation. Admin
     * transfers ignore the yearly transfer limit.
     */
    public function releaseActivation(string $activationId, stdClass $data): void
    {
        $this->permission->assertCanOperate();

        $activation = $this->entityManager->getEntityById('LmDeviceActivation', $activationId);

        if (!$activation) {
            throw new NotFound('Device activation not found');
        }

        $this->permission->assertCanRead($activation);

        $result = $this->client->post(
            '/v1/admin/activations/' . ServerClient::encodeSegment((string) $activation->get('serverId')) . '/release',
            [
                'reason' => (string) ($data->reason ?? ''),
                'assisted' => !empty($data->assisted),
                'actor' => $this->actor(),
            ]
        );

        $license = $this->mirror->applyDetail($result);
        $this->pullAudit($license);
    }
}
