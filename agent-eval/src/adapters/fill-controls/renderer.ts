import { InvoiceFormDraftSchema, invoiceHeaderFields, invoiceLineFields } from '../../../../packages/contracts/src/invoice.ts';
import { createInvoiceFormState, bindInvoiceFormRun, applyInvoiceForm, queryInvoiceFormApplication, cancelInvoiceFormRun,
    type InvoiceFormState } from '../../../../apps/desktop/renderer/src/invoice-form.ts';
import { fillEnvelopeSchema } from './protocol.ts';

const controls = (window as unknown as { invoiceControls: { receive(handler: (raw: unknown) => void): void; reply(raw: unknown): void; ready(): void } }).invoiceControls;
let state: InvoiceFormState | null = null;
const form = document.createElement('form'); form.setAttribute('aria-label', 'Invoice form'); document.body.append(form);
function render() {
    form.replaceChildren();
    if (!state) return;
    const input = (path: string, value: string) => {
        const label = document.createElement('label'); label.textContent = path;
        const field = document.createElement('input'); field.name = path; field.value = value; field.readOnly = true;
        label.append(field); form.append(label);
    };
    for (const name of invoiceHeaderFields) input('fields.' + name, state.draft.fields[name]);
    state.draft.lines.forEach((line, index) => { for (const name of invoiceLineFields) input(`lines.${index}.${name}`, line[name]); });
    state.draft.notes.forEach((note, index) => input('notes.' + index, note));
}
function inspect() {
    if (!state) throw new Error('Form is unavailable');
    const value = (path: string) => {
        const field = form.elements.namedItem(path);
        if (!(field instanceof HTMLInputElement)) throw new Error('Actual form control is unavailable');
        return field.value;
    };
    const draft = InvoiceFormDraftSchema.parse({ fields: Object.fromEntries(invoiceHeaderFields.map(name => [name, value('fields.' + name)])),
        lines: state.draft.lines.map((_, index) => Object.fromEntries(invoiceLineFields.map(name => [name, value(`lines.${index}.${name}`)]))),
        notes: state.draft.notes.map((_, index) => value('notes.' + index)) });
    if (JSON.stringify(draft) !== JSON.stringify(state.draft)) throw new Error('Actual form controls differ from the application state');
    return { formInstanceId: state.formInstanceId, revision: state.revision, dirty: state.dirty, valid: state.valid, basis: state.basis, draft, lineOrigins: state.lineOrigins };
}
controls.receive(raw => {
    const parsed = fillEnvelopeSchema.safeParse(raw); if (!parsed.success) return;
    const { requestId, command } = parsed.data;
    try {
        let receipt;
        if (command.action === 'open') {
            const { workspace } = command;
            const formInstanceId = crypto.randomUUID();
            state = createInvoiceFormState({ formInstanceId, basis: { sessionId: workspace.sessionId, documentRef: workspace.documentRef!,
                jobId: workspace.jobId!, candidateId: workspace.candidateRef!.id, candidateSequence: workspace.candidateRef!.sequence }, candidate: null, editable: true });
            if (!state) throw new Error('Invalid form owner');
            render(); controls.reply({ requestId, result: { target: { formInstanceId, expectedRevision: 0 }, inspection: inspect() } }); return;
        }
        if (!state) throw new Error('Form is unavailable');
        if (command.action === 'cancel') state = cancelInvoiceFormRun(state);
        if (command.action === 'request') {
            const bound = state.runId === command.request.runId ? state : bindInvoiceFormRun(state, command.request.runId);
            if (!bound) throw new Error('Form Run changed');
            state = bound;
            if (command.request.operation === 'apply') {
                const applied = applyInvoiceForm(state, command.request, new Date().toISOString()); state = applied.state; receipt = applied.receipt;
                render();
            } else receipt = queryInvoiceFormApplication(state, command.request, new Date().toISOString());
        }
        controls.reply({ requestId, result: { inspection: inspect(), ...(receipt ? { receipt } : {}) } });
    } catch (error) { controls.reply({ requestId, error: error instanceof Error ? error.message.slice(0, 256) : 'Form control failed' }); }
});
controls.ready();
