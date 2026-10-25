<?php

namespace Espo\Modules\LicenseManager\Tools;

use Espo\Core\Exceptions\Error;
use Espo\Core\Utils\Log;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerClient;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;
use Espo\ORM\EntityManager;

/**
 * Pulls every license, device activation and audit entry changed on the
 * license server since the last run (scheduled every 5 minutes).
 *
 * When the server's database was restored from a backup, its generation
 * number changes: the whole mirror is then rebuilt, and licenses the server
 * no longer knows are marked "Missing on server".
 */
class SyncService
{
    private const STATE_FILE = 'data/license-manager/sync-state.json';
    private const LOCK_FILE = 'data/license-manager/sync.lock';
    private const PAGE_SIZE = 500;
    private const MAX_PAGES = 200;

    public function __construct(
        private ServerClient $client,
        private Mirror $mirror,
        private EntityManager $entityManager,
        private Log $log
    ) {}

    public function getState(): array
    {
        if (!is_file(self::STATE_FILE)) {
            return [];
        }

        $data = json_decode((string) file_get_contents(self::STATE_FILE), true);

        return is_array($data) ? $data : [];
    }

    private function saveState(array $state): void
    {
        if (!is_dir(dirname(self::STATE_FILE))) {
            mkdir(dirname(self::STATE_FILE), 0775, true);
        }

        file_put_contents(self::STATE_FILE . '.tmp', json_encode($state, JSON_PRETTY_PRINT));
        rename(self::STATE_FILE . '.tmp', self::STATE_FILE);
    }

    /**
     * @return array{licenses: int, activations: int, audit: int, fullResync: bool, restoreDetected: bool}
     * @throws ServerException
     * @throws Error
     */
    public function run(): array
    {
        if (!is_dir(dirname(self::LOCK_FILE))) {
            mkdir(dirname(self::LOCK_FILE), 0775, true);
        }

        $lock = fopen(self::LOCK_FILE, 'c');

        if (!$lock || !flock($lock, LOCK_EX | LOCK_NB)) {
            throw new Error('A synchronization with the license server is already running');
        }

        $state = $this->getState();
        $state['lastRunAt'] = gmdate('c');

        try {
            $result = $this->pull($state);
            $state['lastSuccessAt'] = gmdate('c');
            $state['lastError'] = null;
            $state['lastResult'] = $result;
            $this->saveState($state);

            return $result;
        } catch (ServerException $e) {
            $state['lastError'] = $e->getMessage();
            $this->saveState($state);
            $this->log->warning('License Manager sync failed: ' . $e->getMessage());

            throw $e;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    private function pull(array &$state): array
    {
        $since = (int) ($state['since'] ?? 0);
        $auditSince = (int) ($state['auditSince'] ?? 0);
        $full = $since === 0;
        $restoreDetected = false;
        $seen = [];
        $counts = ['licenses' => 0, 'activations' => 0, 'audit' => 0];

        for ($page = 0; $page < self::MAX_PAGES; $page++) {
            $changes = $this->client->get('/v1/admin/changes', [
                'since' => $since,
                'auditSince' => $auditSince,
                'limit' => self::PAGE_SIZE,
            ]);

            if ($page === 0 && !empty($state['instanceId'])) {
                $sameServer = $changes['instanceId'] === $state['instanceId'] &&
                    (int) $changes['generation'] === (int) ($state['generation'] ?? 0);

                if (!$sameServer && ($since !== 0 || $auditSince !== 0)) {
                    $this->log->warning(
                        'License Manager: the license server database was restored or replaced; resynchronizing everything'
                    );

                    $restoreDetected = true;
                    $full = true;
                    $since = 0;
                    $auditSince = 0;
                    $state['instanceId'] = $changes['instanceId'];
                    $state['generation'] = (int) $changes['generation'];
                    $page = -1;

                    continue;
                }
            }

            $state['instanceId'] = $changes['instanceId'];
            $state['generation'] = (int) $changes['generation'];

            foreach ($changes['licenses'] as $license) {
                $this->mirror->upsertLicense($license, $full);
                $seen[$license['id']] = true;
                $counts['licenses']++;
            }

            foreach ($changes['activations'] as $activation) {
                $this->mirror->upsertActivation($activation, $full);
                $counts['activations']++;
            }

            foreach ($changes['audit'] as $entry) {
                $this->mirror->upsertAudit($entry);
                $counts['audit']++;
            }

            $since = (int) $changes['nextSince'];
            $auditSince = (int) $changes['nextAuditSince'];
            $state['since'] = $since;
            $state['auditSince'] = $auditSince;

            if (empty($changes['more'])) {
                break;
            }
        }

        $this->mirror->resolvePendingLinks();

        if ($full) {
            $this->markMissing($seen);
        }

        $this->updateExpiredStatuses();
        $this->updatePlanLockFlags();

        return $counts + ['fullResync' => $full, 'restoreDetected' => $restoreDetected];
    }

    /**
     * After a full pass, licenses the server did not report no longer exist
     * there (sold after the backup that was restored).
     */
    private function markMissing(array $seen): void
    {
        $licenses = $this->entityManager->getRDBRepository('LmLicense')
            ->where(['syncStatus' => 'Synced'])
            ->find();

        foreach ($licenses as $license) {
            if (!isset($seen[$license->get('serverId')])) {
                $license->set('syncStatus', 'Missing on server');
                $this->entityManager->saveEntity($license, [Mirror::SAVE_OPTION => true, 'silent' => true]);

                // Lets staff issue the lost licenses again from the order.
                $order = $license->get('orderId') ?
                    $this->entityManager->getEntityById('LmLicenseOrder', $license->get('orderId')) : null;

                if ($order && $order->get('issuanceStatus') === 'Issued') {
                    $order->set('issuanceStatus', 'Partially Issued');
                    $this->entityManager->saveEntity($order, ['silent' => true]);
                }
            }
        }
    }

    /**
     * Expiry happens with the passage of time, not with a server change, so
     * the mirror updates those statuses itself.
     */
    public function updateExpiredStatuses(): void
    {
        $now = gmdate('Y-m-d H:i:s');

        $expired = $this->entityManager->getRDBRepository('LmLicense')
            ->where([
                'status' => ['active', 'available', 'past_due'],
                'validUntil!=' => null,
                'validUntil<=' => $now,
            ])
            ->find();

        foreach ($expired as $license) {
            $license->set('status', 'expired');
            $this->entityManager->saveEntity($license, [Mirror::SAVE_OPTION => true, 'silent' => true]);
        }

        $pastDue = $this->entityManager->getRDBRepository('LmLicense')
            ->where([
                'status' => ['active', 'available'],
                'licenseType' => 'subscription',
                'expiresAt<=' => $now,
                'validUntil>' => $now,
            ])
            ->find();

        foreach ($pastDue as $license) {
            $license->set('status', 'past_due');
            $this->entityManager->saveEntity($license, [Mirror::SAVE_OPTION => true, 'silent' => true]);
        }
    }

    private function updatePlanLockFlags(): void
    {
        $plans = $this->entityManager->getRDBRepository('LmLicensePlan')
            ->where(['hasLicenses' => false])
            ->find();

        foreach ($plans as $plan) {
            $count = $this->entityManager->getRDBRepository('LmLicense')
                ->where(['planId' => $plan->getId()])
                ->count();

            if ($count > 0) {
                $plan->set('hasLicenses', true);
                $this->entityManager->saveEntity($plan, [CatalogPusher::SKIP_PUSH_OPTION => true, 'silent' => true]);
            }
        }
    }
}
