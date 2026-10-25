/**
 * "Issue Licenses" on the Licenses list: trials, free plans and goodwill
 * grants without an order line.
 */
define('license-manager:handlers/license-list-actions', ['license-manager:lib/util'], function (Util) {

    return class {

        constructor(view) {
            this.view = view;
        }

        isVisible() {
            return Util.canOperate(this.view);
        }

        issueLicenses() {
            this.view.createView('lmIssue', 'license-manager:views/modals/issue-licenses', {}, modal => {
                modal.render();

                this.view.listenToOnce(modal, 'issued', () => {
                    if (this.view.collection) {
                        this.view.collection.fetch();
                    }
                });
            });
        }
    };
});
