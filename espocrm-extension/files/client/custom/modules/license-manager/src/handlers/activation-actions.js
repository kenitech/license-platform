/**
 * Actions on a device activation: Assisted Transfer and Release Device.
 * Both free the computer's slot; admin transfers ignore the yearly limit.
 */
define('license-manager:handlers/activation-actions', ['license-manager:lib/util'], function (Util) {

    return class {

        constructor(view) {
            this.view = view;
            this.model = view.model;
        }

        isVisible() {
            return Util.canOperate(this.view) && this.model.get('status') === 'active';
        }

        release(assisted) {
            Util.openOperation(this.view, {
                headerText: (assisted ? 'Assisted transfer: ' : 'Release device: ') + this.model.get('name'),
                message: assisted ?
                    'Frees this computer so the customer can activate the same key on the new one. ' +
                    'Support transfers ignore the yearly transfer limit.' :
                    'Frees this computer\'s slot. The application stops working on it when it next connects.',
                fields: [{name: 'reason', type: 'textarea', label: 'Reason', required: true, minLength: 3}],
                confirmLabel: assisted ? 'Assisted Transfer' : 'Release Device',
                confirmStyle: 'danger',
                onConfirm: values => Espo.Ajax
                    .postRequest(`LicenseManager/activation/${this.model.id}/release`, {reason: values.reason, assisted})
                    .then(() => {
                        Espo.Ui.success('Device released');
                        this.model.fetch();
                    }),
            });
        }

        assistedTransfer() {
            this.release(true);
        }

        releaseDevice() {
            this.release(false);
        }
    };
});
