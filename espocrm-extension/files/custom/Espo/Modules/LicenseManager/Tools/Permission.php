<?php

namespace Espo\Modules\LicenseManager\Tools;

use Espo\Core\Acl;
use Espo\Core\Exceptions\Forbidden;
use Espo\ORM\Entity;

/**
 * "License Operations" is a role permission (Administration → Roles):
 * issuing, revoking, extending, renewing, transferring, recovering and
 * approving orders all require it.
 */
class Permission
{
    public const SCOPE = 'LicenseOperations';

    public function __construct(private Acl $acl) {}

    public function canOperate(): bool
    {
        return $this->acl->checkScope(self::SCOPE);
    }

    /**
     * @throws Forbidden
     */
    public function assertCanOperate(): void
    {
        if (!$this->canOperate()) {
            throw new Forbidden('You do not have permission to perform license operations');
        }
    }

    /**
     * @throws Forbidden
     */
    public function assertCanRead(Entity $entity): void
    {
        if (!$this->acl->checkEntityRead($entity)) {
            throw new Forbidden('You do not have access to this record');
        }
    }
}
