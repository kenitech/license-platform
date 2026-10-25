/**
 * Shared helpers for the License Manager client code.
 */
define('license-manager:lib/util', [], function () {

    return {
        requestId() {
            if (window.crypto && window.crypto.randomUUID) {
                return window.crypto.randomUUID().replace(/-/g, '');
            }

            return Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        },

        /**
         * Opens the License keys window and resolves when it is closed.
         */
        showKeys(view, keys, error) {
            return new Promise(resolve => {
                view.createView('lmKeys', 'license-manager:views/modals/license-keys', {keys, error}, modal => {
                    modal.render();
                    view.listenToOnce(modal, 'close', () => resolve());
                });
            });
        },

        openOperation(view, options) {
            return new Promise(resolve => {
                view.createView('lmOperation', 'license-manager:views/modals/operation', options, modal => {
                    modal.render();
                    view.listenToOnce(modal, 'close', () => resolve());
                });
            });
        },

        canOperate(view) {
            return view.getAcl().check('LicenseOperations');
        },
    };
});
