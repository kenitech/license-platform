/**
 * Licensing → Licenses → Issue Licenses: choose a plan, a customer and
 * optionally a contact and an order. A paid plan without an order needs an
 * administrative grant reason, which is recorded in the audit log.
 */
define('license-manager:views/modals/issue-licenses', ['views/modal', 'license-manager:lib/util'], function (Dep, Util) {

    const escape = (text) => String(text ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    return class extends Dep {

        className = 'dialog dialog-record';

        templateContent = `
            <div class="cell form-group">
                <label class="control-label">License Plan *</label>
                <select class="form-control" name="planId">
                    <option value="">Select a plan</option>
                    {{{planOptions}}}
                </select>
            </div>
            {{#each links}}
            <div class="cell form-group">
                <label class="control-label">{{label}}</label>
                <div class="input-group">
                    <input type="text" class="form-control" readonly data-link="{{name}}" value="{{value}}" placeholder="None">
                    <span class="input-group-btn">
                        <button class="btn btn-default btn-icon action" type="button" data-action="selectLink" data-name="{{name}}"
                            title="Select"><span class="fas fa-angle-up"></span></button>
                        <button class="btn btn-default btn-icon action" type="button" data-action="clearLink" data-name="{{name}}"
                            title="Clear"><span class="fas fa-times"></span></button>
                    </span>
                </div>
            </div>
            {{/each}}
            <div class="cell form-group">
                <label class="control-label">Quantity *</label>
                <input type="number" class="form-control" name="quantity" min="1" max="1000" value="1">
            </div>
            <div class="cell form-group">
                <label class="control-label">Administrative grant reason</label>
                <textarea class="form-control" name="grantReason" rows="2"></textarea>
                <div class="small text-muted">Required for a paid plan without an order (at least 5 characters).
                    Recorded in the audit log.</div>
            </div>
        `;

        // Elements with class "action" and data-action call actionSelectLink / actionClearLink.
        actionSelectLink(data) {
            this.selectLink(data.name);
        }

        actionClearLink(data) {
            this.values[data.name] = null;
            this.$el.find(`[data-link="${data.name}"]`).val('');
        }

        setup() {
            this.headerText = this.translate('Issue Licenses', 'labels', 'LmLicense');
            this.requestId = Util.requestId();
            this.values = {account: null, contact: null, order: null};
            this.linkDefs = [
                {name: 'account', label: 'Customer', scope: 'Account'},
                {name: 'contact', label: 'Contact', scope: 'Contact'},
                {name: 'order', label: 'Order', scope: 'LmLicenseOrder'},
            ];

            this.buttonList = [
                {name: 'issue', label: 'Issue Licenses', style: 'primary'},
                {name: 'cancel', label: 'Cancel'},
            ];

            this.plans = [];

            this.wait(
                Espo.Ajax.getRequest('LmLicensePlan', {
                    select: 'id,name,applicationName,price,priceCurrency,syncStatus,licenseType',
                    where: [{type: 'equals', attribute: 'status', value: 'Active'}],
                    orderBy: 'name',
                    maxSize: 200,
                }).then(response => {
                    this.plans = response.list || [];
                })
            );
        }

        data() {
            return {
                planOptions: this.plans.map(p => {
                    const price = p.price ? ` (${p.price} ${p.priceCurrency || ''})` : ' (free)';
                    const pending = p.syncStatus !== 'Synced' ? ' [not synced]' : '';

                    return `<option value="${escape(p.id)}">${escape(p.applicationName)}: ${escape(p.name)}` +
                        `${escape(price)}${escape(pending)}</option>`;
                }).join(''),
                links: this.linkDefs.map(l => ({...l, value: this.values[l.name]?.name || ''})),
            };
        }

        selectLink(name) {
            const def = this.linkDefs.find(l => l.name === name);

            this.createView('select', 'views/modals/select-records', {
                scope: def.scope,
                multiple: false,
                createButton: false,
            }, view => {
                view.render();

                this.listenToOnce(view, 'select', model => {
                    const selected = Array.isArray(model) ? model[0] : model;

                    this.values[name] = {id: selected.id, name: selected.get('name')};
                    this.$el.find(`[data-link="${name}"]`).val(selected.get('name'));

                    if (name === 'order' && !this.values.account && selected.get('accountId')) {
                        this.values.account = {id: selected.get('accountId'), name: selected.get('accountName')};
                        this.$el.find('[data-link="account"]').val(selected.get('accountName'));
                    }
                });
            });
        }

        actionIssue() {
            const planId = this.$el.find('[name="planId"]').val();
            const quantity = parseInt(this.$el.find('[name="quantity"]').val(), 10);
            const grantReason = String(this.$el.find('[name="grantReason"]').val() || '').trim();
            const plan = this.plans.find(p => p.id === planId);

            if (!plan) {
                Espo.Ui.error('Choose a license plan');

                return;
            }

            if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
                Espo.Ui.error('Quantity must be from 1 to 1000');

                return;
            }

            if (plan.price > 0 && !this.values.order && grantReason.length < 5) {
                Espo.Ui.error('A paid plan issued without an order needs an Administrative grant reason (at least 5 characters)');

                return;
            }

            this.disableButton('issue');
            Espo.Ui.notify(' ... ');

            Espo.Ajax.postRequest('LicenseManager/license/issue', {
                planId,
                quantity,
                grantReason,
                accountId: this.values.account?.id || null,
                contactId: this.values.contact?.id || null,
                orderId: this.values.order?.id || null,
                requestId: this.requestId,
            }).then(result => {
                Espo.Ui.notify(false);
                this.trigger('issued');

                const parent = this.getParentView();

                this.close();
                Util.showKeys(parent, result.keys || [], result.error);
            }).catch(() => this.enableButton('issue'));
        }
    };
});
