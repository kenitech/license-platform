<?php

use Espo\Core\Container;
use Espo\Core\InjectableFactory;
use Espo\Core\Utils\Config;
use Espo\Core\Utils\Config\ConfigWriter;
use Espo\ORM\EntityManager;

/**
 * Removes the scheduled job and the Licensing tab group. Data tables and the
 * connection settings are kept, so reinstalling restores everything.
 */
class AfterUninstall
{
    public function run(Container $container, array $params = []): void
    {
        /** @var EntityManager $entityManager */
        $entityManager = $container->getByClass(EntityManager::class);
        /** @var Config $config */
        $config = $container->getByClass(Config::class);

        $jobs = $entityManager->getRDBRepository('ScheduledJob')
            ->where(['job' => 'LicenseManagerSync'])
            ->find();

        foreach ($jobs as $job) {
            $entityManager->removeEntity($job);
        }

        $tabList = array_values(array_filter(
            $config->get('tabList') ?? [],
            fn ($item) => !(is_object($item) && ($item->id ?? null) === 'lm-licensing')
        ));

        $writer = $container->getByClass(InjectableFactory::class)->create(ConfigWriter::class);
        $writer->set('tabList', $tabList);
        $writer->save();
    }
}
