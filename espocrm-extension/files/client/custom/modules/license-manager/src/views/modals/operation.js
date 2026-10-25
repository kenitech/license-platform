/**
 * Confirmation window for a license operation. Builds a small form from
 * `fields`, then calls `onConfirm(values)`, which returns a promise. The
 * window closes when the promise resolves and stays open when it fails, so
 * the user can retry (retrying is safe).
 *
 * Field: {name, type: text|textarea|int|enum|date|bool|checklist, label,
 *         required, options: [{value, label}], value, help, min}
 */
define('license-manager:views/modals/operation', ['views/modal'], function (Dep) {

    const escape = (text) => String(text ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    return class extends Dep {

        className = 'dialog dialog-record';

        templateContent = `
            {{#if message}}<p class="lm-message">{{message}}</p>{{/if}}
            <div class="lm-form">{{{formHtml}}}</div>
        `;

        setup() {
            this.headerText = this.options.headerText;
            this.fields = this.options.fields || [];

            this.buttonList = [
                {
                    name: 'confirm',
                    label: this.options.confirmLabel || 'Confirm',
                    style: this.options.confirmStyle || 'primary',
                },
                {
                    name: 'cancel',
                    label: 'Cancel',
                },
            ];
        }

        data() {
            return {
                message: this.options.message,
                formHtml: this.fields.map(f => this.fieldHtml(f)).join(''),
            };
        }

        fieldHtml(f) {
            const id = 'lm-' + f.name;
            const label = escape(f.label) + (f.required ? ' *' : '');
            const help = f.help ? `<div class="small text-muted">${escape(f.help)}</div>` : '';
            let input;

            switch (f.type) {
                case 'textarea':
                    input = `<textarea class="form-control" rows="3" name="${f.name}" id="${id}">${escape(f.value)}</textarea>`;
                    break;

                case 'int':
                    input = `<input type="number" class="form-control" name="${f.name}" id="${id}"
                        min="${f.min ?? 1}" step="1" value="${escape(f.value)}">`;
                    break;

                case 'date':
                    input = `<input type="date" class="form-control" name="${f.name}" id="${id}" value="${escape(f.value)}">`;
                    break;

                case 'enum':
                    input = `<select class="form-control" name="${f.name}" id="${id}">` +
                        (f.options || []).map(o => `<option value="${escape(o.value)}"
                            ${o.value === f.value ? 'selected' : ''}>${escape(o.label)}</option>`).join('') +
                        '</select>';
                    break;

                case 'bool':
                    return `<div class="cell form-group"><label class="checkbox-inline">
                        <input type="checkbox" name="${f.name}" id="${id}" ${f.value ? 'checked' : ''}>
                        ${escape(f.label)}</label>${help}</div>`;

                case 'checklist':
                    input = (f.options || []).map(o => `<div><label class="checkbox-inline">
                        <input type="checkbox" name="${f.name}" value="${escape(o.value)}" ${o.checked ? 'checked' : ''}>
                        ${escape(o.label)}</label></div>`).join('') ||
                        '<div class="text-muted">None</div>';
                    break;

                default:
                    input = `<input type="text" class="form-control" name="${f.name}" id="${id}" value="${escape(f.value)}">`;
            }

            return `<div class="cell form-group" data-name="${f.name}">
                <label class="control-label" for="${id}">${label}</label>${input}${help}</div>`;
        }

        fetchValues() {
            const values = {};

            for (const f of this.fields) {
                if (f.type === 'checklist') {
                    values[f.name] = this.$el.find(`input[name="${f.name}"]:checked`).toArray().map(el => el.value);

                    continue;
                }

                const $el = this.$el.find(`[name="${f.name}"]`);

                if (f.type === 'bool') {
                    values[f.name] = $el.is(':checked');

                    continue;
                }

                const raw = String($el.val() ?? '').trim();

                values[f.name] = f.type === 'int' && raw !== '' ? parseInt(raw, 10) : raw;
            }

            return values;
        }

        validateValues(values) {
            for (const f of this.fields) {
                const v = values[f.name];
                const empty = v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length);

                if (f.required && empty) {
                    Espo.Ui.error(`${f.label}: required`);

                    return false;
                }

                if (f.minLength && typeof v === 'string' && v.length < f.minLength) {
                    Espo.Ui.error(`${f.label}: at least ${f.minLength} characters`);

                    return false;
                }

                if (f.type === 'int' && !empty && (!Number.isInteger(v) || v < (f.min ?? 1))) {
                    Espo.Ui.error(`${f.label}: enter a whole number`);

                    return false;
                }
            }

            return this.options.validate ? this.options.validate(values) : true;
        }

        actionConfirm() {
            const values = this.fetchValues();

            if (!this.validateValues(values)) {
                return;
            }

            this.disableButton('confirm');
            Espo.Ui.notify(' ... ');

            Promise.resolve(this.options.onConfirm(values))
                .then(() => {
                    Espo.Ui.notify(false);
                    this.close();
                })
                .catch(() => this.enableButton('confirm'));
        }
    };
});
