<?php

namespace Espo\Modules\LicenseManager\Hooks\LmDeviceActivation;

use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Hook\Hook\BeforeRemove;
use Espo\Core\Hook\Hook\BeforeSave;
use Espo\Modules\LicenseManager\Tools\Mirror;
use Espo\ORM\Entity;
use Espo\ORM\Repository\Option\RemoveOptions;
use Espo\ORM\Repository\Option\SaveOptions;

/**
 * Device activations mirror the license server. They change only through the license
 * actions (which go to the server first) and the sync job.
 */
class ProtectMirror implements BeforeSave, BeforeRemove
{
    public function beforeSave(Entity $entity, SaveOptions $options): void
    {
        if (!$options->get(Mirror::SAVE_OPTION)) {
            throw new Forbidden('Device activations mirror the license server and cannot be edited here.');
        }
    }

    public function beforeRemove(Entity $entity, RemoveOptions $options): void
    {
        if (!$options->get(Mirror::SAVE_OPTION)) {
            throw new Forbidden('Device activations mirror the license server and cannot be deleted.');
        }
    }
}
