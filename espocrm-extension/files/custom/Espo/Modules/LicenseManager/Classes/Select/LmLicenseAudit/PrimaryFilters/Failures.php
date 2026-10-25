<?php

namespace Espo\Modules\LicenseManager\Classes\Select\LmLicenseAudit\PrimaryFilters;

use Espo\Core\Select\Primary\Filter;
use Espo\ORM\Query\SelectBuilder;

class Failures implements Filter
{
    public function apply(SelectBuilder $queryBuilder): void
    {
        $queryBuilder->where(['action' => ['activation_failed', 'trial_denied']]);
    }
}
