<?php

namespace Espo\Modules\LicenseManager\Api;

use Espo\Core\Acl;
use Espo\Core\Api\Action;
use Espo\Core\Api\Request;
use Espo\Core\Api\Response;
use Espo\Core\Api\ResponseComposer;
use Espo\Core\Exceptions\Forbidden;
use Espo\ORM\EntityManager;

/**
 * Counts for the License Summary dashlet.
 */
class GetSummary implements Action
{
    public function __construct(
        private Acl $acl,
        private EntityManager $entityManager
    ) {}

    public function process(Request $request): Response
    {
        if (!$this->acl->checkScope('LmLicense', 'read')) {
            throw new Forbidden();
        }

        $count = fn (array $where) => $this->entityManager->getRDBRepository('LmLicense')->where($where)->count();

        $now = gmdate('Y-m-d H:i:s');

        return ResponseComposer::json([
            'active' => $count(['status' => ['active', 'past_due']]),
            'available' => $count(['status' => 'available']),
            'expiring' => $count([
                'status' => ['active', 'available', 'past_due'],
                'expiresAt>=' => $now,
                'expiresAt<=' => gmdate('Y-m-d H:i:s', time() + 30 * 86400),
            ]),
            'expired' => $count(['status' => 'expired']),
            'revoked' => $count(['status' => ['revoked', 'suspended']]),
        ]);
    }
}
