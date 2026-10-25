<?php

namespace Espo\Modules\LicenseManager\Api;

use Espo\Core\Api\Action;
use Espo\Core\Api\Request;
use Espo\Core\Api\Response;
use Espo\Core\Api\ResponseComposer;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;
use Espo\Modules\LicenseManager\Tools\OperationService;

/**
 * "Release Device" and "Assisted Transfer" on a device activation.
 */
class PostActivationRelease implements Action
{
    public function __construct(private OperationService $operationService) {}

    public function process(Request $request): Response
    {
        try {
            $this->operationService->releaseActivation((string) $request->getRouteParam('id'), $request->getParsedBody());
        } catch (ServerException $e) {
            throw $e->toEspoException();
        }

        return ResponseComposer::json(true);
    }
}
