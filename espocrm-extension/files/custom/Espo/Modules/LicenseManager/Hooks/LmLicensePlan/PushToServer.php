<?php

namespace Espo\Modules\LicenseManager\Hooks\LmLicensePlan;

use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Hook\Hook\BeforeSave;
use Espo\Modules\LicenseManager\Tools\CatalogPusher;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;
use Espo\ORM\Entity;
use Espo\ORM\Repository\Option\SaveOptions;

/**
 * Creates or updates the plan on the license server before it is saved.
 * Changing a plan never changes licenses already sold.
 */
class PushToServer implements BeforeSave
{
    private const PUSHED_FIELDS = [
        'name', 'licenseType', 'durationValue', 'durationUnit', 'renewalPolicy', 'maxDevices', 'price',
        'priceCurrency', 'transferPolicy', 'transfersPerYear', 'offlineGracePeriod', 'paymentGracePeriod',
        'entitlements', 'status',
    ];

    public function __construct(private CatalogPusher $pusher) {}

    public function beforeSave(Entity $entity, SaveOptions $options): void
    {
        if (!$entity->isNew()) {
            if ($entity->isAttributeChanged('planCode')) {
                throw new BadRequest('The Plan Code can never be changed: create a new plan instead');
            }

            if ($entity->isAttributeChanged('applicationId')) {
                throw new BadRequest('A plan cannot be moved to another application: create a new plan instead');
            }

            if ($entity->get('hasLicenses') && $entity->isAttributeChanged('licenseType')) {
                throw new BadRequest(
                    'Licenses exist for this plan, so its License Type is locked. Create a new plan and archive this one.'
                );
            }
        }

        if ($options->get(CatalogPusher::SKIP_PUSH_OPTION)) {
            return;
        }

        $changed = $entity->isNew() || $entity->get('syncStatus') !== 'Synced';

        foreach (self::PUSHED_FIELDS as $field) {
            $changed = $changed || $entity->isAttributeChanged($field);
        }

        if (!$changed) {
            return;
        }

        if (!$this->pusher->isConfigured()) {
            $this->pusher->markPending($entity, 'Saved before the license server connection was configured. Click Sync to License Server.');

            return;
        }

        try {
            $this->pusher->pushPlan($entity);
        } catch (ServerException $e) {
            throw $e->toEspoException();
        }
    }
}
