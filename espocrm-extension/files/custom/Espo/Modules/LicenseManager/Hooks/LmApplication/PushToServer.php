<?php

namespace Espo\Modules\LicenseManager\Hooks\LmApplication;

use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Hook\Hook\BeforeSave;
use Espo\Modules\LicenseManager\Tools\CatalogPusher;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;
use Espo\ORM\Entity;
use Espo\ORM\Repository\Option\SaveOptions;

/**
 * Registers or updates the application on the license server before it is
 * saved. If the server refuses, nothing is saved and its message is shown.
 */
class PushToServer implements BeforeSave
{
    private const PUSHED_FIELDS = [
        'name', 'currentVersion', 'supportedOperatingSystems', 'offlinePolicy', 'offlineCheckDays', 'status',
    ];

    public function __construct(private CatalogPusher $pusher) {}

    public function beforeSave(Entity $entity, SaveOptions $options): void
    {
        if (!$entity->isNew() && $entity->isAttributeChanged('productIdentifier')) {
            throw new BadRequest('The Product Identifier can never be changed: it is written into every license');
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
            $this->pusher->pushApplication($entity);
        } catch (ServerException $e) {
            throw $e->toEspoException();
        }
    }
}
