<?php

use Espo\Core\Container;
use Espo\Core\InjectableFactory;
use Espo\Core\Utils\Config;
use Espo\Core\Utils\Config\ConfigWriter;
use Espo\Core\Utils\Log;
use Espo\ORM\EntityManager;

/**
 * Runs once after the extension is installed or upgraded:
 *  - creates the scheduled job "License Manager: Sync with License Server" (every 5 minutes),
 *  - adds the Licensing tab group to the navigation menu,
 *  - sets the default issuing rule,
 *  - adds a Licensing tab with licenses, orders and devices to Accounts.
 */
class AfterInstall
{
    private const JOB = 'LicenseManagerSync';
    private const TAB_GROUP_ID = 'lm-licensing';
    private const TAB_ITEMS = [
        'LmApplication', 'LmLicensePlan', 'LmLicenseOrder', 'LmLicense', 'LmDeviceActivation', 'LmLicenseAudit',
    ];

    public function run(Container $container, array $params = []): void
    {
        /** @var EntityManager $entityManager */
        $entityManager = $container->getByClass(EntityManager::class);
        /** @var Config $config */
        $config = $container->getByClass(Config::class);
        /** @var InjectableFactory $factory */
        $factory = $container->getByClass(InjectableFactory::class);

        $this->createJob($entityManager);
        $this->updateConfig($config, $factory->create(ConfigWriter::class));

        try {
            $this->addAccountTab();
        } catch (\Throwable $e) {
            // The layout is a convenience; the extension works without it.
            $container->getByClass(Log::class)->warning('License Manager: could not add the Account Licensing tab: ' . $e->getMessage());
        }
    }

    private function createJob(EntityManager $entityManager): void
    {
        $existing = $entityManager->getRDBRepository('ScheduledJob')
            ->where(['job' => self::JOB])
            ->findOne();

        if ($existing) {
            return;
        }

        $job = $entityManager->getNewEntity('ScheduledJob');
        $job->set([
            'name' => 'License Manager: Sync with License Server',
            'job' => self::JOB,
            'status' => 'Active',
            'scheduling' => '*/5 * * * *',
        ]);

        $entityManager->saveEntity($job);
    }

    private function updateConfig(Config $config, ConfigWriter $writer): void
    {
        $tabList = $config->get('tabList') ?? [];
        $hasGroup = false;

        foreach ($tabList as $item) {
            if (is_object($item) && ($item->id ?? null) === self::TAB_GROUP_ID) {
                $hasGroup = true;
            }
        }

        if (!$hasGroup) {
            $tabList = array_values(array_filter(
                $tabList,
                fn ($item) => !is_string($item) || !in_array($item, self::TAB_ITEMS, true)
            ));

            $tabList[] = (object) [
                'type' => 'group',
                'text' => 'Licensing',
                'iconClass' => 'fas fa-key',
                'color' => null,
                'id' => self::TAB_GROUP_ID,
                'itemList' => self::TAB_ITEMS,
            ];

            $writer->set('tabList', $tabList);
        }

        if (!$config->has('licenseManagerIssueRequires')) {
            $writer->set('licenseManagerIssueRequires', 'paid_or_approved');
        }

        $writer->save();
    }

    private function readLayout(string $name): ?array
    {
        foreach ([
            "custom/Espo/Custom/Resources/layouts/Account/$name.json",
            "application/Espo/Modules/Crm/Resources/layouts/Account/$name.json",
        ] as $file) {
            if (is_file($file)) {
                $data = json_decode((string) file_get_contents($file), true);

                return is_array($data) ? $data : null;
            }
        }

        return null;
    }

    private function writeLayout(string $name, array $layout): void
    {
        $file = "custom/Espo/Custom/Resources/layouts/Account/$name.json";

        if (!is_dir(dirname($file))) {
            mkdir(dirname($file), 0775, true);
        }

        file_put_contents($file, json_encode($layout, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }

    /**
     * Adds the license panels to Accounts in a "Licensing" tab, keeping any
     * customized layout.
     */
    private function addAccountTab(): void
    {
        $links = ['lmLicenses', 'lmLicenseOrders', 'lmDeviceActivations'];
        $relationships = $this->readLayout('relationships');

        if ($relationships !== null) {
            $names = array_map(fn ($item) => is_array($item) ? ($item['name'] ?? null) : $item, $relationships);
            $missing = array_values(array_diff($links, $names));

            if ($missing) {
                $this->writeLayout('relationships', array_merge($relationships, $missing));
            }
        }

        $layout = $this->readLayout('bottomPanelsDetail') ?? [];

        if (isset($layout['_tabBreak_lm'])) {
            return;
        }

        $max = 0;

        foreach ($layout as $item) {
            if (is_array($item) && isset($item['index'])) {
                $max = max($max, (int) $item['index']);
            }
        }

        $layout['_tabBreak_lm'] = ['index' => $max + 1, 'tabBreak' => true, 'tabLabel' => 'Licensing'];
        $layout['lmLicenses'] = ['index' => $max + 2];
        $layout['lmLicenseOrders'] = ['index' => $max + 3];
        $layout['lmDeviceActivations'] = ['index' => $max + 4];

        $this->writeLayout('bottomPanelsDetail', $layout);
    }
}
