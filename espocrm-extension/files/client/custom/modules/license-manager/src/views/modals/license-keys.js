/**
 * The "License keys" window. Keys are shown once and never stored: the user
 * copies them or downloads a CSV before closing.
 */
define('license-manager:views/modals/license-keys', ['views/modal'], function (Dep) {

    const csvCell = (v) => {
        const text = String(v ?? '');

        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    };

    return class extends Dep {

        className = 'dialog dialog-record';

        backdrop = 'static';

        escapeDisabled = true;

        templateContent = `
            {{#if error}}
                <div class="alert alert-danger">{{error}}</div>
            {{/if}}
            {{#if keys.length}}
                <p class="text-warning"><strong>Copy or download these keys now.</strong>
                    They are shown only once and are not stored anywhere.</p>
                <table class="table table-bordered table-condensed">
                    <thead><tr><th>Reference</th><th>License key</th><th>Plan</th><th>Expires</th></tr></thead>
                    <tbody>
                    {{#each keys}}
                        <tr>
                            <td>{{reference}}</td>
                            <td><code style="user-select: all; font-size: 1.05em;">{{key}}</code></td>
                            <td>{{plan}}</td>
                            <td>{{#if expiresAt}}{{expiresAt}}{{else}}Never{{/if}}</td>
                        </tr>
                    {{/each}}
                    </tbody>
                </table>
            {{else}}
                {{#unless error}}<p>No new licenses were issued.</p>{{/unless}}
            {{/if}}
        `;

        setup() {
            this.headerText = this.translate('License keys', 'labels', 'LmLicense');
            this.keys = (this.options.keys || []).map(k => ({...k, expiresAt: k.expiresAt ? k.expiresAt.substring(0, 10) : null}));

            this.buttonList = [];

            if (this.keys.length) {
                this.buttonList.push({name: 'copy', label: this.translate('Copy', 'labels', 'LmLicense'), style: 'primary'});
                this.buttonList.push({name: 'download', label: this.translate('Download CSV', 'labels', 'LmLicense')});
            }

            this.buttonList.push({name: 'close', label: 'Close'});
        }

        data() {
            return {keys: this.keys, error: this.options.error};
        }

        text() {
            return this.keys.map(k => `${k.reference}\t${k.key}\t${k.plan || ''}`).join('\n');
        }

        actionCopy() {
            const done = () => Espo.Ui.success('Copied');

            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(this.text()).then(done);

                return;
            }

            const area = document.createElement('textarea');
            area.value = this.text();
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
            done();
        }

        actionDownload() {
            const header = ['Reference', 'License Key', 'Application', 'Plan', 'Customer', 'Expires'];
            const rows = this.keys.map(k => [k.reference, k.key, k.application, k.plan, k.customer, k.expiresAt || '']);
            const csv = [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
            const blob = new Blob([csv], {type: 'text/csv;charset=utf-8'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');

            a.href = url;
            a.download = 'license-keys-' + new Date().toISOString().substring(0, 19).replace(/[:T]/g, '-') + '.csv';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }

        actionCancel() {
            this.actionClose();
        }

        actionClose() {
            if (this.keys.length && !this.confirmedClose) {
                this.confirm('Close the window? The keys will not be shown again.', () => {
                    this.confirmedClose = true;
                    this.actionClose();
                });

                return;
            }

            this.trigger('close-keys');
            this.close();
        }
    };
});
