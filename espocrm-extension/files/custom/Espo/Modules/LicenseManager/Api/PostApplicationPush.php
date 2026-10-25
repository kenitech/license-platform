<?php

namespace Espo\Modules\LicenseManager\Api;

use Espo\Core\Acl;
use Espo\Core\Api\Action;
use Espo\Core\Api\Request;
use Espo\Core\Api\Response;
use Espo\Core\Api\ResponseComposer;
use Espo\Core\Exceptions\Forbidden;
use Espo\Core\Exceptions\NotFound;
use Espo\Modules\LicenseManager\Tools\CatalogPusher;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;
use Espo\ORM\EntityManager;

/**
 * "Sync to License Server" on an application that stayed Pending.
 */
class PostApplicationPush implements Action
{
    public function __construct(
        private Acl $acl,
        private EntityManager $entityManager,
        private CatalogPusher $pusher
    ) {}

    public function process(Request $request): Response
    {
        $entity = $this->entityManager->getEntityById('LmApplication', (string) $request->getRouteParam('id'));

        if (!$entity) {
            throw new NotFound();
        }

        if (!$this->acl->checkEntityEdit($entity)) {
            throw new Forbidden();
        }

        try {
            $this->pusher->pushApplication($entity);
        } catch (ServerException $e) {
            $entity->set(['syncStatus' => 'Error', 'syncMessage' => $e->getMessage()]);
            $this->entityManager->saveEntity($entity, [CatalogPusher::SKIP_PUSH_OPTION => true]);

            throw $e->toEspoException();
        }

        $this->entityManager->saveEntity($entity, [CatalogPusher::SKIP_PUSH_OPTION => true]);

        return ResponseComposer::json(['syncStatus' => $entity->get('syncStatus')]);
    }
}
