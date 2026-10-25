<?php

namespace Espo\Modules\LicenseManager\Classes\Select\LmLicense\PrimaryFilters;

use Espo\Core\Select\Primary\Filter;
use Espo\ORM\Query\SelectBuilder;

/**
 * Licenses that still work today and expire within 30 days.
 */
class Expiring implements Filter
{
    public function apply(SelectBuilder $queryBuilder): void
    {
        $now = gmdate('Y-m-d H:i:s');
        $in30Days = gmdate('Y-m-d H:i:s', time() + 30 * 86400);

        $queryBuilder->where([
            'status' => ['active', 'available', 'past_due'],
            'expiresAt>=' => $now,
            'expiresAt<=' => $in30Days,
        ]);
    }
}
