<?php

namespace Espo\Modules\LicenseManager\Api;

use Espo\Core\Api\Action;
use Espo\Core\Api\Request;
use Espo\Core\Api\Response;
use Espo\Core\Api\ResponseComposer;
use Espo\Modules\LicenseManager\Tools\IssueService;

/**
 * "Issue Licenses" on a License Order.
 */
class PostOrderIssue implements Action
{
    public function __construct(private IssueService $issueService) {}

    public function process(Request $request): Response
    {
        return ResponseComposer::json($this->issueService->issueForOrder((string) $request->getRouteParam('id')));
    }
}
