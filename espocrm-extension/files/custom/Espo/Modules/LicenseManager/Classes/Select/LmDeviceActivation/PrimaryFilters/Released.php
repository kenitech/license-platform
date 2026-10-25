<?php

namespace Espo\Modules\LicenseManager\Classes\Select\LmDeviceActivation\PrimaryFilters;

use Espo\Core\Select\Primary\Filter;
use Espo\ORM\Query\SelectBuilder;

class Released implements Filter
{
    public function apply(SelectBuilder $queryBuilder): void
    {
        $queryBuilder->where(['status' => 'released']);
    }
}
