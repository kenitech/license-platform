<?php

namespace Espo\Modules\LicenseManager\Hooks\LmOrderItem;

use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Hook\Hook\AfterRemove;
use Espo\Core\Hook\Hook\AfterSave;
use Espo\Core\Hook\Hook\BeforeSave;
use Espo\Core\Utils\Config;
use Espo\ORM\Entity;
use Espo\ORM\EntityManager;
use Espo\ORM\Repository\Option\RemoveOptions;
use Espo\ORM\Repository\Option\SaveOptions;

/**
 * A purchased product's price defaults to the plan price, and the order
 * Amount is the sum of its products.
 */
class Amounts implements BeforeSave, AfterSave, AfterRemove
{
    public function __construct(
        private EntityManager $entityManager,
        private Config $config
    ) {}

    public function beforeSave(Entity $entity, SaveOptions $options): void
    {
        $plan = $entity->get('planId') ? $this->entityManager->getEntityById('LmLicensePlan', $entity->get('planId')) : null;

        if (!$plan) {
            throw new BadRequest('Choose a license plan');
        }

        if (!$entity->isNew() && $entity->isAttributeChanged('planId') && (int) $entity->get('issuedCount') > 0) {
            throw new BadRequest('Licenses were already issued for this product, so its plan cannot change');
        }

        if ((int) $entity->get('quantity') < (int) $entity->get('issuedCount')) {
            throw new BadRequest('The quantity cannot be lower than the number of licenses already issued');
        }

        if ($entity->get('unitPrice') === null || ($entity->isNew() && !$entity->has('unitPrice'))) {
            $entity->set('unitPrice', $plan->get('price') ?? 0);
            $entity->set('unitPriceCurrency', $plan->get('priceCurrency') ?: $this->config->get('defaultCurrency'));
        }

        $currency = $entity->get('unitPriceCurrency') ?: $this->config->get('defaultCurrency');

        $entity->set([
            'name' => $plan->get('name'),
            'amount' => round((float) $entity->get('unitPrice') * (int) $entity->get('quantity'), 2),
            'amountCurrency' => $currency,
            'unitPriceCurrency' => $currency,
        ]);
    }

    public function afterSave(Entity $entity, SaveOptions $options): void
    {
        if ($options->get('skipOrderTotal')) {
            return;
        }

        $this->updateOrder($entity->get('orderId'));

        if ($entity->isAttributeChanged('orderId') && $entity->getFetched('orderId')) {
            $this->updateOrder($entity->getFetched('orderId'));
        }
    }

    public function afterRemove(Entity $entity, RemoveOptions $options): void
    {
        $this->updateOrder($entity->get('orderId'));
    }

    private function updateOrder(?string $orderId): void
    {
        $order = $orderId ? $this->entityManager->getEntityById('LmLicenseOrder', $orderId) : null;

        if (!$order) {
            return;
        }

        $items = $this->entityManager->getRDBRepository('LmOrderItem')
            ->where(['orderId' => $orderId])
            ->find();

        $total = 0.0;
        $currency = null;

        foreach ($items as $item) {
            $total += (float) $item->get('amount');
            $currency = $currency ?? $item->get('amountCurrency');
        }

        $order->set([
            'amount' => round($total, 2),
            'amountCurrency' => $currency ?: $this->config->get('defaultCurrency'),
        ]);

        $this->entityManager->saveEntity($order, ['silent' => true]);
    }
}
