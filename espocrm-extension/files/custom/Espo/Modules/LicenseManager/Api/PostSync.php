<?php

namespace Espo\Modules\LicenseManager\Api;

use Espo\Core\Api\Action;
use Espo\Core\Api\Request;
use Espo\Core\Api\Response;
use Espo\Core\Api\ResponseComposer;
use Espo\Core\Exceptions\Forbidden;
use Espo\Entities\User;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;
use Espo\Modules\LicenseManager\Tools\SyncService;

/**
 * "Run Sync Now" on the License Manager admin page.
 */
class PostSync implements Action
{
    public function __construct(
        private User $user,
        private SyncService $syncService
    ) {}

    public function process(Request $request): Response
    {
        if (!$this->user->isAdmin()) {
            throw new Forbidden();
        }

        try {
            $result = $this->syncService->run();
        } catch (ServerException $e) {
            throw $e->toEspoException();
        }

        return ResponseComposer::json($result + ['sync' => $this->syncService->getState()]);
    }
}
