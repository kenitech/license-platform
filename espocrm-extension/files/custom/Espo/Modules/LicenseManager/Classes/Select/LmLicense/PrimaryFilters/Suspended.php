<?php

namespace Espo\Modules\LicenseManager\Classes\Select\LmLicense\PrimaryFilters;

use Espo\Core\Select\Primary\Filter;
use Espo\ORM\Query\SelectBuilder;

class Suspended implements Filter
{
    public function apply(SelectBuilder $queryBuilder): void
    {
        $queryBuilder->where(['status' => 'suspended']);
    }
}
