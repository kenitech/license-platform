/**
 * Administration → License Manager: connection test, audit chain status,
 * signing key and synchronization ("Run Sync Now").
 */
define('license-manager:views/admin/license-manager', ['view'], function (Dep) {

    return class extends Dep {

        templateContent = `
            <div class="page-header"><h3><a href="#Admin">{{translate 'Administration'}}</a>
                <span class="breadcrumb-separator"><span></span></span> License Manager</h3></div>
            <div class="button-container margin-bottom">
                <button class="btn btn-primary" data-action="runSync" {{#unless status.configured}}disabled{{/unless}}>Run Sync Now</button>
                <button class="btn btn-default" data-action="reload">Test Connection</button>
            </div>
            {{#if loading}}<p class="text-muted">Checking the license server ...</p>{{else}}
            <div class="panel panel-default"><div class="panel-body">
                <table class="table table-bordered" style="max-width: 820px;">
                    <tr><th style="width: 260px;">Connection</th><td>
                        {{#ifEqual status.connection 'OK'}}<span class="label label-success">OK</span>
                        {{else}}<span class="label label-danger">{{status.connection}}</span>{{/ifEqual}}
                        {{#if status.message}}<div class="text-danger margin-top-sm">{{status.message}}</div>{{/if}}
                    </td></tr>
                    <tr><th>License server</th><td>{{#if status.serverUrl}}{{status.serverUrl}}{{else}}<span class="text-muted">not set</span>{{/if}}</td></tr>
                    <tr><th>Client ID</th><td>{{#if status.clientId}}{{status.clientId}}{{else}}<span class="text-muted">not set</span>{{/if}}</td></tr>
                    {{#if status.server}}
                    <tr><th>Audit chain</th><td>
                        {{#ifEqual status.server.auditChain 'intact'}}<span class="label label-success">audit chain intact</span>
                        {{else}}<span class="label label-danger">audit chain broken</span>
                            <div class="text-danger margin-top-sm">{{status.server.auditProblem}}.
                            Someone altered the license database: restore from a backup and investigate.</div>{{/ifEqual}}
                        <span class="text-muted small">({{status.server.auditEntries}} entries)</span>
                    </td></tr>
                    <tr><th>Signing key</th><td>{{status.server.signingKid}}
                        <span class="text-muted small">trusted: {{trustedKids}}</span></td></tr>
                    <tr><th>Server database</th><td>generation {{status.server.generation}}
                        <span class="text-muted small">{{status.server.instanceId}}</span></td></tr>
                    <tr><th>On the server</th><td>{{status.server.counts.licenses}} licenses,
                        {{status.server.counts.activeDevices}} active devices,
                        {{status.server.counts.applications}} applications, {{status.server.counts.plans}} plans</td></tr>
                    {{/if}}
                    <tr><th>Issue licenses when</th><td>{{issueRule}}</td></tr>
                    <tr><th>Last sync</th><td>{{#if status.sync.lastSuccessAt}}{{status.sync.lastSuccessAt}}{{else}}<span class="text-muted">never</span>{{/if}}
                        {{#if status.sync.lastError}}<div class="text-danger">Last error: {{status.sync.lastError}}</div>{{/if}}</td></tr>
                </table>
                {{#unless status.configured}}
                <p>Enter the connection on the EspoCRM server, in the EspoCRM folder:</p>
<pre>php command.php config:set licenseManagerServerUrl https://licenses.example.com
php command.php config:set licenseManagerClientId espocrm
php command.php config:set licenseManagerClientSecret '&lt;CRM secret&gt;'</pre>
                {{/unless}}
            </div></div>
            {{/if}}
        `;

        setup() {
            this.addActionHandler('runSync', () => this.runSync());
            this.addActionHandler('reload', () => this.load());

            this.loading = true;
            this.status = {};
            this.load();
        }

        data() {
            const rules = {
                paid_or_approved: 'the order is Paid or Administrative Approval is Approved',
                paid: 'the order is Paid',
            };

            return {
                loading: this.loading,
                status: this.status,
                trustedKids: (this.status.server?.trustedKids || []).join(', '),
                issueRule: rules[this.status.issueRequires] || this.status.issueRequires,
            };
        }

        load() {
            this.loading = true;

            if (this.isRendered()) {
                this.reRender();
            }

            Espo.Ajax.getRequest('LicenseManager/status').then(status => {
                this.status = status;
                this.loading = false;
                this.reRender();
            });
        }

        runSync() {
            Espo.Ui.notify('Synchronizing ...');

            Espo.Ajax.postRequest('LicenseManager/sync', {}, {timeout: 0}).then(result => {
                const parts = [`${result.licenses} licenses`, `${result.activations} devices`, `${result.audit} audit entries`];
                const restored = result.restoreDetected ? ' The license server database was restored: everything was resynchronized.' : '';

                Espo.Ui.success('Synchronized ' + parts.join(', ') + '.' + restored);
                this.load();
            }).catch(() => this.load());
        }

        updatePageTitle() {
            this.setPageTitle('License Manager');
        }
    };
});
