/**
 * License Summary dashlet: counts of active, available, expiring, expired and
 * revoked licenses, each linking to the filtered Licenses list.
 */
define('license-manager:views/dashlets/license-summary', ['views/dashlets/abstract/base'], function (Dep) {

    return class extends Dep {

        name = 'LicenseSummary';

        templateContent = `
            <div class="lm-summary" style="display: flex; flex-wrap: wrap; gap: 12px; padding: 4px 0;">
                {{#each items}}
                <a href="#LmLicense/list/primaryFilter={{filter}}" class="lm-summary-item"
                    style="flex: 1 1 90px; text-decoration: none; padding: 8px 10px; border-radius: 4px; border: 1px solid var(--default-border-color, #ddd);">
                    <div style="font-size: 1.8em; font-weight: 600;" class="text-{{style}}">{{count}}</div>
                    <div class="text-muted">{{label}}</div>
                </a>
                {{/each}}
            </div>
        `;

        setup() {
            this.counts = null;
        }

        data() {
            const c = this.counts || {};
            const items = [
                {filter: 'active', label: 'Active', count: c.active, style: 'success'},
                {filter: 'available', label: 'Available', count: c.available, style: 'primary'},
                {filter: 'expiring', label: 'Expiring in 30 days', count: c.expiring, style: 'warning'},
                {filter: 'expired', label: 'Expired', count: c.expired, style: 'muted'},
                {filter: 'revoked', label: 'Revoked or suspended', count: c.revoked, style: 'danger'},
            ];

            return {items: items.map(i => ({...i, count: i.count ?? '…'}))};
        }

        afterRender() {
            if (this.counts) {
                return;
            }

            Espo.Ajax.getRequest('LicenseManager/summary').then(counts => {
                this.counts = counts;
                this.reRender();
            });
        }

        actionRefresh() {
            this.counts = null;
            this.reRender();
        }
    };
});
