/**
 * "Sync to License Server" on applications and plans that stayed Pending
 * (saved before the connection was configured) or failed.
 */
define('license-manager:handlers/sync-actions', [], function () {

    return class {

        constructor(view) {
            this.view = view;
            this.model = view.model;
        }

        isVisible() {
            return this.view.getAcl().checkModel(this.model, 'edit');
        }

        push(kind) {
            Espo.Ui.notify(' ... ');

            Espo.Ajax.postRequest(`LicenseManager/${kind}/${this.model.id}/push`).then(() => {
                Espo.Ui.success('Synced with the license server');
                this.model.fetch();
            }).catch(() => this.model.fetch());
        }

        syncApplication() {
            this.push('application');
        }

        syncPlan() {
            this.push('plan');
        }
    };
});
