<?php

namespace Espo\Modules\LicenseManager\Api;

use Espo\Core\Api\Action;
use Espo\Core\Api\Request;
use Espo\Core\Api\Response;
use Espo\Core\Api\ResponseComposer;
use Espo\Modules\LicenseManager\Tools\IssueService;

/**
 * Licensing → Licenses → Issue Licenses (without an order line).
 */
class PostLicenseIssue implements Action
{
    public function __construct(private IssueService $issueService) {}

    public function process(Request $request): Response
    {
        return ResponseComposer::json($this->issueService->issueDirect($request->getParsedBody()));
    }
}
