<?php

namespace Espo\Modules\LicenseManager\Jobs;

use Espo\Core\Job\JobDataLess;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerClient;
use Espo\Modules\LicenseManager\Tools\SyncService;

/**
 * Scheduled job "License Manager: Sync with License Server" (every 5 minutes).
 */
class SyncWithLicenseServer implements JobDataLess
{
    public function __construct(
        private SyncService $syncService,
        private ServerClient $client
    ) {}

    public function run(): void
    {
        if (!$this->client->isConfigured()) {
            return;
        }

        $this->syncService->run();
    }
}
