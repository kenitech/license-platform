<?php

namespace Espo\Modules\LicenseManager\Tools;

use Espo\Core\Utils\Language;
use Espo\ORM\Entity;
use Espo\ORM\EntityManager;

/**
 * Writes what the license server reports into the read-only mirror entities
 * (LmLicense, LmDeviceActivation, LmLicenseAudit).
 */
class Mirror
{
    /** Save option that lets the mirror guard hooks through. */
    public const SAVE_OPTION = 'lmSync';

    private array $applicationIds = [];
    private array $planIds = [];

    public function __construct(
        private EntityManager $entityManager,
        private Language $language
    ) {}

    public static function toDbDateTime(?string $iso): ?string
    {
        if ($iso === null || $iso === '') {
            return null;
        }

        $time = strtotime($iso);

        return $time === false ? null : gmdate('Y-m-d H:i:s', $time);
    }

    public static function nowDb(): string
    {
        return gmdate('Y-m-d H:i:s');
    }

    private function save(Entity $entity): void
    {
        $this->entityManager->saveEntity($entity, [self::SAVE_OPTION => true, 'silent' => true]);
    }

    private function findApplicationId(?string $productId): ?string
    {
        if (!$productId) {
            return null;
        }

        if (!array_key_exists($productId, $this->applicationIds)) {
            $app = $this->entityManager->getRDBRepository('LmApplication')
                ->where(['productIdentifier' => $productId])
                ->findOne();

            $this->applicationIds[$productId] = $app?->getId();
        }

        return $this->applicationIds[$productId];
    }

    private function findPlanId(?string $applicationId, ?string $planCode): ?string
    {
        if (!$applicationId || !$planCode) {
            return null;
        }

        $key = $applicationId . '/' . $planCode;

        if (!array_key_exists($key, $this->planIds)) {
            $plan = $this->entityManager->getRDBRepository('LmLicensePlan')
                ->where(['applicationId' => $applicationId, 'planCode' => $planCode])
                ->findOne();

            $this->planIds[$key] = $plan?->getId();
        }

        return $this->planIds[$key];
    }

    private function existingId(string $entityType, ?string $id): ?string
    {
        if (!$id) {
            return null;
        }

        return $this->entityManager->getEntityById($entityType, $id) ? $id : null;
    }

    /**
     * @param array<string, mixed> $v A license as the server reports it.
     * @param bool $force Apply even when the mirror already has a newer revision (after a restore).
     */
    public function upsertLicense(array $v, bool $force = false): Entity
    {
        $repository = $this->entityManager->getRDBRepository('LmLicense');
        $license = $repository->where(['serverId' => $v['id']])->findOne() ?? $this->entityManager->getNewEntity('LmLicense');

        if (!$force && !$license->isNew() && (int) $license->get('serverRev') > (int) ($v['rev'] ?? 0)) {
            return $license;
        }

        $applicationId = $this->findApplicationId($v['productId'] ?? null);

        $orderId = null;

        if (!empty($v['orderRef'])) {
            $order = $this->entityManager->getRDBRepository('LmLicenseOrder')
                ->where(['name' => $v['orderRef']])
                ->findOne();

            $orderId = $order?->getId();
        }

        $license->set([
            'name' => $v['reference'],
            'serverId' => $v['id'],
            'status' => $v['status'],
            'statusReason' => $v['statusReason'] ?? null,
            'productIdentifier' => $v['productId'] ?? null,
            'planCode' => $v['planCode'] ?? null,
            'applicationId' => $applicationId,
            'planId' => $this->findPlanId($applicationId, $v['planCode'] ?? null),
            'licenseType' => $v['type'] ?? null,
            'keyLast4' => $v['keyLast4'] ?? null,
            'accountId' => $this->existingId('Account', $v['customerId'] ?? null),
            'contactId' => $this->existingId('Contact', $v['contactId'] ?? null),
            'orderId' => $orderId,
            'orderItemId' => $v['orderItemId'] ?? null,
            'grantReason' => $v['grantReason'] ?? null,
            'maxDevices' => $v['maxDevices'] ?? null,
            'activeDevices' => $v['activeDevices'] ?? 0,
            'entitlements' => $v['entitlements'] ?? [],
            'renewalPolicy' => $v['renewalPolicy'] ?? null,
            'transferPolicy' => $v['transferPolicy'] ?? null,
            'transfersPerYear' => $v['transfersPerYear'] ?? null,
            'transfersUsedThisYear' => $v['transfersUsedThisYear'] ?? 0,
            'issuedAt' => self::toDbDateTime($v['issuedAt'] ?? null),
            'startsAt' => self::toDbDateTime($v['startsAt'] ?? null),
            'expiresAt' => self::toDbDateTime($v['expiresAt'] ?? null),
            'validUntil' => self::toDbDateTime($v['validUntil'] ?? null),
            'autoRenew' => (bool) ($v['autoRenew'] ?? false),
            'cancelAtPeriodEnd' => (bool) ($v['cancelAtPeriodEnd'] ?? false),
            'cancelledAt' => self::toDbDateTime($v['cancelledAt'] ?? null),
            'serverRev' => (int) ($v['rev'] ?? 0),
            'syncStatus' => 'Synced',
            'lastSyncedAt' => self::nowDb(),
        ]);

        $this->save($license);

        return $license;
    }

    /**
     * @param array<string, mixed> $v A device activation as the server reports it.
     */
    public function upsertActivation(array $v, bool $force = false): Entity
    {
        $repository = $this->entityManager->getRDBRepository('LmDeviceActivation');
        $activation = $repository->where(['serverId' => $v['id']])->findOne() ??
            $this->entityManager->getNewEntity('LmDeviceActivation');

        if (!$force && !$activation->isNew() && (int) $activation->get('serverRev') > (int) ($v['rev'] ?? 0)) {
            return $activation;
        }

        $license = $this->entityManager->getRDBRepository('LmLicense')
            ->where(['serverId' => $v['licenseId']])
            ->findOne();

        $activation->set([
            'name' => $v['deviceName'] ?: ('Device ' . ($v['deviceFingerprint'] ?? '')),
            'serverId' => $v['id'],
            'licenseServerId' => $v['licenseId'],
            'licenseId' => $license?->getId(),
            'accountId' => $license?->get('accountId'),
            'status' => $v['status'],
            'deviceFingerprint' => $v['deviceFingerprint'] ?? null,
            'operatingSystem' => $v['os'] ?? null,
            'appVersion' => $v['appVersion'] ?? null,
            'activatedAt' => self::toDbDateTime($v['activatedAt'] ?? null),
            'lastSeenAt' => self::toDbDateTime($v['lastSeenAt'] ?? null),
            'releasedAt' => self::toDbDateTime($v['releasedAt'] ?? null),
            'releaseKind' => $v['releaseKind'] ?? '',
            'serverRev' => (int) ($v['rev'] ?? 0),
        ]);

        $this->save($activation);

        return $activation;
    }

    /**
     * @param array<string, mixed> $v An audit entry as the server reports it.
     */
    public function upsertAudit(array $v): void
    {
        $entry = $this->entityManager->getRDBRepository('LmLicenseAudit')
            ->where(['seq' => (int) $v['seq']])
            ->findOne() ?? $this->entityManager->getNewEntity('LmLicenseAudit');

        $license = null;

        if (!empty($v['licenseId'])) {
            $license = $this->entityManager->getRDBRepository('LmLicense')
                ->where(['serverId' => $v['licenseId']])
                ->findOne();
        }

        $details = $v['details'] ?? [];

        $entry->set([
            'name' => $this->language->translateOption($v['action'], 'action', 'LmLicenseAudit'),
            'seq' => (int) $v['seq'],
            'at' => self::toDbDateTime($v['at'] ?? null),
            'action' => $v['action'],
            'actorType' => $v['actorType'] ?? null,
            'actorName' => $v['actorName'] ?? null,
            'licenseId' => $license?->getId(),
            'licenseReference' => $v['licenseReference'] ?? null,
            'productIdentifier' => $v['productId'] ?? null,
            'ipAddress' => $v['ip'] ?? null,
            'details' => $details ? json_encode($details, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) : null,
        ]);

        $this->save($entry);
    }

    /**
     * @param array{license: array, activations?: array} $detail
     */
    public function applyDetail(array $detail): Entity
    {
        $license = $this->upsertLicense($detail['license'], true);

        foreach ($detail['activations'] ?? [] as $activation) {
            $this->upsertActivation($activation, true);
        }

        return $license;
    }

    /**
     * Links activations and audit entries that arrived before their license.
     */
    public function resolvePendingLinks(): void
    {
        $licenses = $this->entityManager->getRDBRepository('LmLicense');

        $activations = $this->entityManager->getRDBRepository('LmDeviceActivation')
            ->where(['licenseId' => null, 'licenseServerId!=' => null])
            ->limit(0, 5000)
            ->find();

        foreach ($activations as $activation) {
            $license = $licenses->where(['serverId' => $activation->get('licenseServerId')])->findOne();

            if ($license) {
                $activation->set(['licenseId' => $license->getId(), 'accountId' => $license->get('accountId')]);
                $this->save($activation);
            }
        }

        $entries = $this->entityManager->getRDBRepository('LmLicenseAudit')
            ->where(['licenseId' => null, 'licenseReference!=' => null])
            ->limit(0, 5000)
            ->find();

        foreach ($entries as $entry) {
            $license = $licenses->where(['name' => $entry->get('licenseReference')])->findOne();

            if ($license) {
                $entry->set('licenseId', $license->getId());
                $this->save($entry);
            }
        }
    }
}
