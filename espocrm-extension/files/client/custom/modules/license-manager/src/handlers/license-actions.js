/**
 * Actions in the dropdown next to Edit on a license. Each one opens a
 * confirmation window, goes to the license server first and is recorded in
 * the license's Audit History with the user's name.
 */
define('license-manager:handlers/license-actions', ['license-manager:lib/util'], function (Util) {

    const reasonField = (required = true) => ({
        name: 'reason', type: 'textarea', label: 'Reason', required, minLength: required ? 3 : 0,
    });

    return class {

        constructor(view) {
            this.view = view;
            this.model = view.model;
        }

        status() {
            return this.model.get('status');
        }

        isRefreshVisible() {
            return true;
        }

        isOperationVisible() {
            return Util.canOperate(this.view) && this.model.get('syncStatus') !== 'Missing on server';
        }

        isExtendVisible() {
            return this.isOperationVisible() && ['fixed_term', 'trial'].includes(this.model.get('licenseType')) &&
                !['revoked', 'cancelled'].includes(this.status());
        }

        isRenewVisible() {
            return this.isOperationVisible() && ['subscription', 'fixed_term'].includes(this.model.get('licenseType')) &&
                ['manual', 'automatic'].includes(this.model.get('renewalPolicy')) &&
                !['revoked', 'cancelled'].includes(this.status());
        }

        isCancelVisible() {
            return this.isOperationVisible() && this.model.get('licenseType') === 'subscription' &&
                !['revoked', 'cancelled', 'expired'].includes(this.status());
        }

        isSuspendVisible() {
            return this.isOperationVisible() && !['suspended', 'revoked'].includes(this.status());
        }

        isReactivateVisible() {
            return this.isOperationVisible() && ['suspended', 'revoked', 'cancelled'].includes(this.status());
        }

        isRevokeVisible() {
            return this.isOperationVisible() && this.status() !== 'revoked';
        }

        isReleaseAllVisible() {
            return this.isOperationVisible() && (this.model.get('activeDevices') || 0) > 0;
        }

        url(operation) {
            return `LicenseManager/license/${this.model.id}/operation/${operation}`;
        }

        reload() {
            this.model.fetch();
            this.view.trigger('lm:changed');

            const parent = this.view.getParentView && this.view.getParentView();

            if (parent && parent.updateRelationshipPanel) {
                parent.updateRelationshipPanel('deviceActivations');
                parent.updateRelationshipPanel('auditEntries');
            }
        }

        operation(operation, options) {
            const requestId = Util.requestId();

            return Util.openOperation(this.view, {
                ...options,
                onConfirm: values => {
                    const data = {...(options.transform ? options.transform(values) : values), requestId};

                    return Espo.Ajax.postRequest(this.url(operation), data).then(result => {
                        this.reload();

                        if (result && (result.keys || result.error)) {
                            // After this window has closed.
                            setTimeout(() => Util.showKeys(this.view, result.keys || [], result.error), 0);

                            return;
                        }

                        Espo.Ui.success(options.successMessage || 'Done');
                    });
                },
            });
        }

        refresh() {
            Espo.Ui.notify(' ... ');

            Espo.Ajax.postRequest(`LicenseManager/license/${this.model.id}/refresh`).then(() => {
                Espo.Ui.success('Refreshed from the license server');
                this.reload();
            });
        }

        suspend() {
            this.operation('suspend', {
                headerText: 'Suspend license ' + this.model.get('name'),
                message: 'The application stops working when the computer next connects. Undo with Reactivate.',
                fields: [reasonField()],
                confirmLabel: 'Suspend',
                confirmStyle: 'danger',
                successMessage: 'Suspended',
            });
        }

        reactivate() {
            this.operation('reactivate', {
                headerText: 'Reactivate license ' + this.model.get('name'),
                fields: [reasonField(false)],
                confirmLabel: 'Reactivate',
                successMessage: 'Reactivated',
            });
        }

        revoke() {
            this.operation('revoke', {
                headerText: 'Revoke license ' + this.model.get('name'),
                message: 'For refunds, chargebacks or abuse. Takes effect when the computer next connects; ' +
                    'a lifetime license on a computer that never goes online again cannot be stopped remotely.',
                fields: [reasonField()],
                confirmLabel: 'Revoke',
                confirmStyle: 'danger',
                successMessage: 'Revoked',
            });
        }

        extend() {
            const expires = this.model.get('expiresAt');

            this.operation('extend', {
                headerText: 'Extend license ' + this.model.get('name'),
                message: 'Current expiry: ' + (expires ? expires.substring(0, 10) : 'none') +
                    '. Enter either a number and unit, or a new expiry date.',
                fields: [
                    {name: 'value', type: 'int', label: 'Add', min: 1},
                    {name: 'unit', type: 'enum', label: 'Unit', value: 'days', options: [
                        {value: 'days', label: 'Days'}, {value: 'months', label: 'Months'}, {value: 'years', label: 'Years'},
                    ]},
                    {name: 'expiresAt', type: 'date', label: 'Or new expiry date'},
                    reasonField(false),
                ],
                validate: v => {
                    if (!v.value && !v.expiresAt) {
                        Espo.Ui.error('Enter a number of days, months or years, or a new expiry date');

                        return false;
                    }

                    return true;
                },
                transform: v => v.expiresAt ? {expiresAt: v.expiresAt, reason: v.reason} : {value: v.value, unit: v.unit, reason: v.reason},
                confirmLabel: 'Extend',
                successMessage: 'Extended',
            });
        }

        renew() {
            this.operation('renew', {
                headerText: 'Renew license ' + this.model.get('name'),
                message: 'Adds paid periods of the plan to the license.',
                fields: [
                    {name: 'periods', type: 'int', label: 'Periods', value: 1, required: true, min: 1},
                    {name: 'paymentRef', type: 'text', label: 'Payment reference'},
                ],
                confirmLabel: 'Renew',
                successMessage: 'Renewed',
            });
        }

        cancelSubscription() {
            this.operation('cancel-subscription', {
                headerText: 'Cancel subscription ' + this.model.get('name'),
                fields: [
                    {name: 'atPeriodEnd', type: 'bool', label: 'Keep it working until the end of the paid period', value: true},
                    reasonField(false),
                ],
                confirmLabel: 'Cancel Subscription',
                confirmStyle: 'danger',
                successMessage: 'Subscription cancelled',
            });
        }

        replaceKey() {
            this.operation('replace-key', {
                headerText: 'Replace license key ' + this.model.get('name'),
                message: 'A new key is created and shown once. The old key stops working for new activations; ' +
                    'computers already activated keep working.',
                fields: [reasonField()],
                confirmLabel: 'Replace Key',
                confirmStyle: 'danger',
            });
        }

        recover() {
            Espo.Ajax.getRequest('LmDeviceActivation', {
                where: [
                    {type: 'equals', attribute: 'licenseId', value: this.model.id},
                    {type: 'equals', attribute: 'status', value: 'active'},
                ],
                select: 'id,name,operatingSystem,lastSeenAt',
                maxSize: 100,
            }).then(response => {
                const devices = (response.list || []).map(d => ({
                    value: d.id,
                    label: `${d.name}${d.operatingSystem ? ' (' + d.operatingSystem + ')' : ''}` +
                        (d.lastSeenAt ? ', last seen ' + d.lastSeenAt.substring(0, 10) : ''),
                    checked: response.list.length === 1,
                }));

                this.operation('recover', {
                    headerText: 'Recover (lost device) ' + this.model.get('name'),
                    message: 'Releases the lost, stolen or dead computer so the customer can activate a new one.',
                    fields: [
                        {name: 'activationIds', type: 'checklist', label: 'Computers to release', options: devices, required: devices.length > 0},
                        reasonField(),
                        {name: 'replaceKey', type: 'bool', label: 'Also replace the license key (if the key may be misused)'},
                    ],
                    confirmLabel: 'Recover',
                    confirmStyle: 'danger',
                    successMessage: 'Devices released',
                });
            });
        }

        releaseAll() {
            this.operation('release-all', {
                headerText: 'Release all devices of ' + this.model.get('name'),
                message: 'Every computer is released; the customer activates again.',
                fields: [reasonField()],
                confirmLabel: 'Release All Devices',
                confirmStyle: 'danger',
                successMessage: 'All devices released',
            });
        }
    };
});
