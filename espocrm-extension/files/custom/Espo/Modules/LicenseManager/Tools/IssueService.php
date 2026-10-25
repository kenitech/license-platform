<?php

namespace Espo\Modules\LicenseManager\Tools;

use Espo\Core\Exceptions\BadRequest;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Exceptions\NotFound;
use Espo\Core\Utils\Config;
use Espo\Entities\User;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerClient;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;
use Espo\ORM\Entity;
use Espo\ORM\EntityManager;

/**
 * Issues licenses on the license server. Keys come back once, are returned
 * to the browser and are never stored in EspoCRM.
 */
class IssueService
{
    public function __construct(
        private ServerClient $client,
        private Mirror $mirror,
        private Permission $permission,
        private EntityManager $entityManager,
        private Config $config,
        private User $user
    ) {}

    private function actor(): array
    {
        return ['id' => $this->user->getId(), 'name' => $this->user->get('name') ?: $this->user->get('userName')];
    }

    /**
     * @throws Forbidden
     */
    public function assertOrderAllowsIssuing(Entity $order): void
    {
        $paid = $order->get('paymentStatus') === 'Paid';
        $approved = $order->get('administrativeApproval') === 'Approved';
        $rule = $this->config->get('licenseManagerIssueRequires') ?: 'paid_or_approved';

        if ($rule === 'paid') {
            if (!$paid) {
                throw new Forbidden('Licenses are issued only after the order is paid');
            }

            return;
        }

        if (!$paid && !$approved) {
            throw new Forbidden('Paid licenses are issued only after the order is paid or administratively approved');
        }
    }

    private function planContext(string $planId): array
    {
        $plan = $this->entityManager->getEntityById('LmLicensePlan', $planId);

        if (!$plan) {
            throw new NotFound('License plan not found');
        }

        $app = $plan->get('applicationId') ?
            $this->entityManager->getEntityById('LmApplication', $plan->get('applicationId')) : null;

        if (!$app) {
            throw new BadRequest('The plan "' . $plan->get('name') . '" has no application');
        }

        if ($plan->get('syncStatus') !== 'Synced' || $app->get('syncStatus') !== 'Synced') {
            throw new BadRequest(
                'The plan "' . $plan->get('name') . '" is not synced with the license server: ' .
                'open the application and the plan and click Sync to License Server'
            );
        }

        return [$plan, $app];
    }

    private function keyRow(array $issued, Entity $plan, Entity $app, ?Entity $account): array
    {
        return [
            'reference' => $issued['reference'],
            'key' => $issued['key'],
            'application' => $app->get('name'),
            'plan' => $plan->get('name'),
            'customer' => $account?->get('name'),
            'expiresAt' => $issued['expiresAt'] ?? null,
        ];
    }

    /**
     * "Issue Licenses" on an order: issues every missing license of every
     * purchased product. On failure, the keys already issued are returned
     * together with the error, and clicking again issues only the rest.
     *
     * @return array{keys: array, error: ?string, issuanceStatus: string}
     */
    public function issueForOrder(string $orderId): array
    {
        $this->permission->assertCanOperate();

        $order = $this->entityManager->getEntityById('LmLicenseOrder', $orderId);

        if (!$order) {
            throw new NotFound('Order not found');
        }

        $this->permission->assertCanRead($order);
        $this->assertOrderAllowsIssuing($order);

        $account = $order->get('accountId') ? $this->entityManager->getEntityById('Account', $order->get('accountId')) : null;

        if (!$account) {
            throw new BadRequest('Choose the customer of the order first');
        }

        $items = $this->entityManager->getRDBRepository('LmOrderItem')
            ->where(['orderId' => $order->getId()])
            ->order('createdAt')
            ->find();

        if (!count($items)) {
            throw new BadRequest('Add at least one product in the Purchased Products panel');
        }

        $keys = [];
        $error = null;

        foreach ($items as $item) {
            try {
                [$plan, $app] = $this->planContext((string) $item->get('planId'));

                $result = $this->client->post('/v1/admin/licenses/issue', [
                    'productId' => $app->get('productIdentifier'),
                    'planCode' => $plan->get('planCode'),
                    'quantity' => (int) $item->get('quantity'),
                    'customer' => ['id' => $account->getId(), 'name' => $account->get('name')],
                    'contactId' => $order->get('contactId'),
                    'order' => ['ref' => $order->get('name'), 'itemId' => $item->getId()],
                    'actor' => $this->actor(),
                ]);
            } catch (ServerException|BadRequest|NotFound $e) {
                $error = $e->getMessage();

                break;
            }

            foreach ($result['issued'] as $issued) {
                $this->mirror->upsertLicense($issued);
                $keys[] = $this->keyRow($issued, $plan, $app, $account);
            }

            foreach ($result['existing'] ?? [] as $existing) {
                $this->mirror->upsertLicense($existing);
            }

            $item->set('issuedCount', (int) $result['alreadyIssued'] + count($result['issued']));
            $this->entityManager->saveEntity($item, ['silent' => true, 'skipOrderTotal' => true]);
        }

        $status = $this->updateIssuanceStatus($order);

        return ['keys' => $keys, 'error' => $error, 'issuanceStatus' => $status];
    }

    public function updateIssuanceStatus(Entity $order): string
    {
        $items = $this->entityManager->getRDBRepository('LmOrderItem')
            ->where(['orderId' => $order->getId()])
            ->find();

        $wanted = 0;
        $issued = 0;

        foreach ($items as $item) {
            $wanted += (int) $item->get('quantity');
            $issued += min((int) $item->get('issuedCount'), (int) $item->get('quantity'));
        }

        $status = match (true) {
            $issued === 0 => 'Not Issued',
            $issued >= $wanted => 'Issued',
            default => 'Partially Issued',
        };

        if ($order->get('issuanceStatus') !== $status) {
            $order->set('issuanceStatus', $status);
            $this->entityManager->saveEntity($order, ['silent' => true]);
        }

        return $status;
    }

    /**
     * Licensing → Licenses → Issue Licenses: trials, free plans and goodwill
     * grants, optionally attached to an order.
     *
     * @return array{keys: array, error: ?string, replayed: bool}
     */
    public function issueDirect(\stdClass $data): array
    {
        $this->permission->assertCanOperate();

        $planId = (string) ($data->planId ?? '');
        $quantity = (int) ($data->quantity ?? 1);
        $requestId = preg_replace('/[^A-Za-z0-9_-]/', '', (string) ($data->requestId ?? ''));
        $grantReason = trim((string) ($data->grantReason ?? ''));

        if ($planId === '') {
            throw new BadRequest('Choose a license plan');
        }

        if ($quantity < 1 || $quantity > 1000) {
            throw new BadRequest('Quantity must be from 1 to 1000');
        }

        if (strlen($requestId) < 8) {
            throw new BadRequest('requestId is required');
        }

        [$plan, $app] = $this->planContext($planId);

        $account = !empty($data->accountId) ? $this->entityManager->getEntityById('Account', $data->accountId) : null;

        if (!empty($data->accountId) && !$account) {
            throw new NotFound('Customer not found');
        }

        $order = !empty($data->orderId) ? $this->entityManager->getEntityById('LmLicenseOrder', $data->orderId) : null;

        if (!empty($data->orderId) && !$order) {
            throw new NotFound('Order not found');
        }

        if ($order) {
            $this->permission->assertCanRead($order);
            $this->assertOrderAllowsIssuing($order);
        } elseif ((float) $plan->get('price') > 0 && mb_strlen($grantReason) < 5) {
            throw new BadRequest(
                'A paid plan issued without an order needs an Administrative grant reason (at least 5 characters)'
            );
        }

        $body = [
            'productId' => $app->get('productIdentifier'),
            'planCode' => $plan->get('planCode'),
            'quantity' => $quantity,
            'customer' => $account ? ['id' => $account->getId(), 'name' => $account->get('name')] : null,
            'contactId' => $data->contactId ?? null,
            'grantReason' => $grantReason !== '' ? $grantReason : null,
            'actor' => $this->actor(),
        ];

        if ($order) {
            // A separate order line per request: a retried request issues
            // only what is missing, never twice.
            $body['order'] = ['ref' => $order->get('name'), 'itemId' => 'direct-' . $requestId];
        }

        try {
            $result = $this->client->post('/v1/admin/licenses/issue', $body, 'issue-' . $requestId);
        } catch (ServerException $e) {
            return ['keys' => [], 'error' => $e->getMessage(), 'replayed' => false];
        }

        $keys = [];

        foreach ($result['issued'] as $issued) {
            $this->mirror->upsertLicense($issued);

            if (!empty($issued['key'])) {
                $keys[] = $this->keyRow($issued, $plan, $app, $account);
            }
        }

        $replayed = !empty($result['replayed']) || (!$keys && !empty($result['existing']));

        return [
            'keys' => $keys,
            'error' => $replayed ? 'These licenses were already issued and their keys were shown then. Use Replace License Key if a key was lost.' : null,
            'replayed' => $replayed,
        ];
    }
}
