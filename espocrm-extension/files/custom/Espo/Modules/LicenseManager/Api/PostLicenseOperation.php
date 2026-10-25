<?php

namespace Espo\Modules\LicenseManager\Api;

use Espo\Core\Api\Action;
use Espo\Core\Api\Request;
use Espo\Core\Api\Response;
use Espo\Core\Api\ResponseComposer;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;
use Espo\Modules\LicenseManager\Tools\OperationService;

/**
 * Suspend, reactivate, revoke, extend, renew, cancel subscription, replace
 * key, recover (lost device) and release all devices.
 */
class PostLicenseOperation implements Action
{
    public function __construct(private OperationService $operationService) {}

    public function process(Request $request): Response
    {
        try {
            $result = $this->operationService->run(
                (string) $request->getRouteParam('id'),
                (string) $request->getRouteParam('operation'),
                $request->getParsedBody()
            );
        } catch (ServerException $e) {
            throw $e->toEspoException();
        }

        return ResponseComposer::json($result);
    }
}
