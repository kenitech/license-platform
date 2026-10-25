<?php

namespace Espo\Modules\LicenseManager\Tools;

use Espo\Core\Utils\Config;
use Espo\Entities\User;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerClient;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;
use Espo\ORM\Entity;
use Espo\ORM\EntityManager;

/**
 * Sends applications and plans to the license server. The server is the
 * authority: if it refuses, the caller does not save the record.
 */
class CatalogPusher
{
    /** Save option: the record was already pushed (or must not be). */
    public const SKIP_PUSH_OPTION = 'lmSkipPush';

    public function __construct(
        private ServerClient $client,
        private EntityManager $entityManager,
        private Config $config,
        private User $user
    ) {}

    public function isConfigured(): bool
    {
        return $this->client->isConfigured();
    }

    private function actor(): array
    {
        return ['id' => $this->user->getId(), 'name' => $this->user->get('name') ?: $this->user->get('userName')];
    }

    public function applicationPayload(Entity $app): array
    {
        $os = $app->get('supportedOperatingSystems') ?? [];

        return [
            'name' => (string) $app->get('name'),
            'currentVersion' => $app->get('currentVersion') ?: null,
            'supportedOs' => array_values(array_map('strval', $os)),
            'offlinePolicy' => $app->get('offlinePolicy') ?: 'perpetual',
            'offlineCheckDays' => $app->get('offlinePolicy') === 'periodic' ? (int) $app->get('offlineCheckDays') : null,
            'status' => $app->get('status') === 'Archived' ? 'archived' : 'active',
            'actor' => $this->actor(),
        ];
    }

    public function planPayload(Entity $plan): array
    {
        $type = (string) $plan->get('licenseType');
        $hasDuration = $type !== 'lifetime';
        $price = (float) ($plan->get('price') ?? 0);

        return [
            'name' => (string) $plan->get('name'),
            'type' => $type,
            'durationValue' => $hasDuration ? $plan->get('durationValue') : null,
            'durationUnit' => $hasDuration ? $plan->get('durationUnit') : null,
            'renewalPolicy' => $hasDuration ? ($plan->get('renewalPolicy') ?: 'none') : 'none',
            'maxDevices' => (int) ($plan->get('maxDevices') ?: 1),
            'priceCents' => (int) round($price * 100),
            'currency' => $plan->get('priceCurrency') ?: $this->config->get('defaultCurrency'),
            'transferPolicy' => $plan->get('transferPolicy') ?: 'self_service',
            'transfersPerYear' => $plan->get('transferPolicy') === 'limited_per_year' ? (int) $plan->get('transfersPerYear') : null,
            'offlineGraceDays' => in_array($type, ['fixed_term', 'subscription']) ? (int) $plan->get('offlineGracePeriod') : 0,
            'paymentGraceDays' => $type === 'subscription' ? (int) $plan->get('paymentGracePeriod') : 0,
            'entitlements' => array_values(array_filter(array_map('strval', $plan->get('entitlements') ?? []))),
            'status' => $plan->get('status') === 'Archived' ? 'archived' : 'active',
            'actor' => $this->actor(),
        ];
    }

    /**
     * @throws ServerException
     */
    public function pushApplication(Entity $app): void
    {
        $productId = (string) $app->get('productIdentifier');

        $this->client->put(
            '/v1/admin/applications/' . ServerClient::encodeSegment($productId),
            $this->applicationPayload($app)
        );

        $this->markSynced($app);
    }

    /**
     * @throws ServerException
     */
    public function pushPlan(Entity $plan): void
    {
        $app = $plan->get('applicationId') ?
            $this->entityManager->getEntityById('LmApplication', $plan->get('applicationId')) : null;

        if (!$app) {
            throw new ServerException('Choose the application this plan belongs to', 'invalid_request', 400);
        }

        if ($app->get('syncStatus') !== 'Synced') {
            throw new ServerException(
                'The application "' . $app->get('name') . '" is not synced with the license server yet: ' .
                'open it and click Sync to License Server first',
                'application_not_synced',
                409
            );
        }

        $this->client->put(
            '/v1/admin/applications/' . ServerClient::encodeSegment((string) $app->get('productIdentifier')) .
            '/plans/' . ServerClient::encodeSegment((string) $plan->get('planCode')),
            $this->planPayload($plan)
        );

        $this->markSynced($plan);
    }

    private function markSynced(Entity $entity): void
    {
        $entity->set([
            'syncStatus' => 'Synced',
            'syncMessage' => null,
            'lastSyncedAt' => Mirror::nowDb(),
        ]);
    }

    public function markPending(Entity $entity, string $message): void
    {
        $entity->set([
            'syncStatus' => 'Pending',
            'syncMessage' => $message,
        ]);
    }
}
