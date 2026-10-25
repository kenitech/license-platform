/**
 * "Issue Licenses" at the top of a License Order.
 */
define('license-manager:handlers/order-actions', ['license-manager:lib/util'], function (Util) {

    return class {

        constructor(view) {
            this.view = view;
            this.model = view.model;
        }

        isIssueVisible() {
            return Util.canOperate(this.view);
        }

        issueLicenses() {
            const status = this.model.get('issuanceStatus');
            const message = status === 'Issued' ?
                'All licenses of this order were already issued. Issue again to create only licenses that are missing.' :
                'Issues a license for every purchased product. Keys are shown once: copy or download them before closing.';

            this.view.confirm({message, confirmText: 'Issue Licenses'}, () => {
                Espo.Ui.notify(' ... ');

                Espo.Ajax.postRequest(`LicenseManager/order/${this.model.id}/issue`).then(result => {
                    Espo.Ui.notify(false);
                    this.model.fetch();

                    if (this.view.updateRelationshipPanel) {
                        this.view.updateRelationshipPanel('licenses');
                        this.view.updateRelationshipPanel('items');
                    }

                    Util.showKeys(this.view, result.keys || [], result.error);
                });
            });
        }
    };
});
