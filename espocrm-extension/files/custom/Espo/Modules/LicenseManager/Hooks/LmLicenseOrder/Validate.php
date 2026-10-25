<?php

namespace Espo\Modules\LicenseManager\Hooks\LmLicenseOrder;

use Espo\Core\Exceptions\Conflict;
use Espo\Core\Hook\Hook\BeforeSave;
use Espo\Modules\LicenseManager\Tools\Permission;
use Espo\ORM\Entity;
use Espo\ORM\EntityManager;
use Espo\ORM\Repository\Option\SaveOptions;

/**
 * Order references are unique, and only people with License Operations may
 * approve an order administratively.
 */
class Validate implements BeforeSave
{
    public function __construct(
        private EntityManager $entityManager,
        private Permission $permission
    ) {}

    public function beforeSave(Entity $entity, SaveOptions $options): void
    {
        if ($entity->isNew() || $entity->isAttributeChanged('name')) {
            $duplicate = $this->entityManager->getRDBRepository('LmLicenseOrder')
                ->where(['name' => $entity->get('name'), 'id!=' => $entity->getId()])
                ->findOne();

            if ($duplicate) {
                throw new Conflict('Another order already uses the reference "' . $entity->get('name') . '"');
            }
        }

        $approvalChanged = $entity->isAttributeChanged('administrativeApproval');
        $wasApproved = !$entity->isNew() && $entity->getFetched('administrativeApproval') === 'Approved';
        $decided = in_array($entity->get('administrativeApproval'), ['Approved', 'Rejected'], true);

        if ($approvalChanged && ($decided || $wasApproved)) {
            $this->permission->assertCanOperate();
        }
    }
}
