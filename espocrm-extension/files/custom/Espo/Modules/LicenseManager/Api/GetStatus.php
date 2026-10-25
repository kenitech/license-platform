<?php

namespace Espo\Modules\LicenseManager\Api;

use Espo\Core\Api\Action;
use Espo\Core\Api\Request;
use Espo\Core\Api\Response;
use Espo\Core\Api\ResponseComposer;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Utils\Config;
use Espo\Entities\User;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerClient;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;
use Espo\Modules\LicenseManager\Tools\SyncService;

/**
 * Administration → License Manager: connection, audit chain and sync state.
 */
class GetStatus implements Action
{
    public function __construct(
        private User $user,
        private ServerClient $client,
        private SyncService $syncService,
        private Config $config
    ) {}

    public function process(Request $request): Response
    {
        if (!$this->user->isAdmin()) {
            throw new Forbidden();
        }

        $data = [
            'serverUrl' => $this->client->getServerUrl() ?: null,
            'clientId' => $this->config->get('licenseManagerClientId'),
            'issueRequires' => $this->config->get('licenseManagerIssueRequires') ?: 'paid_or_approved',
            'configured' => $this->client->isConfigured(),
            'sync' => $this->syncService->getState(),
            'connection' => 'Not configured',
            'message' => null,
            'server' => null,
        ];

        if ($data['configured']) {
            try {
                $data['server'] = $this->client->get('/v1/admin/status', ['fresh' => '1']);
                $data['connection'] = 'OK';
            } catch (ServerException $e) {
                $data['connection'] = 'Error';
                $data['message'] = $e->getMessage();
            }
        } else {
            $data['message'] = ServerException::notConfigured()->getMessage();
        }

        return ResponseComposer::json($data);
    }
}
