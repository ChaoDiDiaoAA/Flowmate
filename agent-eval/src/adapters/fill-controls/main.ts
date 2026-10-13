import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { fillEnvelopeSchema, fillResponseSchema } from './protocol.ts';
import { checkedInvoiceFormInspection, matchesInvoiceFormRun, matchesInvoiceFormTarget, type InvoiceFormTargetBinding } from '../../../../apps/desktop/main/invoice-form-bridge.ts';

async function start() {
const root = process.argv[2]; if (!root) throw new Error('Missing owned controls root');
app.setPath('userData', join(root, 'profile'));
await app.whenReady();
const window = new BrowserWindow({ show: false, webPreferences: { preload: join(root, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('console-message', event => { if (event.level === 'error') process.stderr.write(event.message + '\n'); });
window.webContents.on('will-navigate', event => event.preventDefault());
let binding: (InvoiceFormTargetBinding & { currentRevision: number }) | null = null;
const owner = () => ({ frame: window.webContents.mainFrame, contents: window.webContents, epoch: binding?.epoch ?? 0 });
window.webContents.on('render-process-gone', () => { if (binding) binding.valid = false; });
window.webContents.on('did-start-navigation', () => { if (binding) binding.valid = false; });
let pending: { value: ReturnType<typeof fillEnvelopeSchema.parse>; timer: ReturnType<typeof setTimeout> } | null = null;
const reply = (value: unknown) => process.send?.(fillResponseSchema.parse(value));
ipcMain.on('invoice-controls:reply', (event, raw: unknown) => {
    const parsed = fillResponseSchema.safeParse(raw), current = pending;
    if (!current || !parsed.success || parsed.data.requestId !== current.value.requestId || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    clearTimeout(current.timer); pending = null;
    const { command } = current.value, response = parsed.data;
    if (response.error) { reply(response); return; }
    const result = response.result!;
    if (command.action === 'request' && result.receipt && (result.receipt.runId !== command.request.runId || result.receipt.toolCallId !== command.request.toolCallId
        || result.receipt.formInstanceId !== command.request.target.formInstanceId || result.receipt.candidateId !== command.request.candidateId
        || result.receipt.candidateSequence !== command.request.candidateSequence)) {
        reply({ requestId: response.requestId, error: 'Form receipt belongs to another original call' }); return;
    }
    if (command.action === 'open' && result.target && result.inspection) {
        binding = { ...owner(), epoch: command.epoch, purpose: 'fill', workspace: command.workspace, target: result.target,
            valid: true, dirty: false, runId: null, pendingFill: true, currentRevision: 0 };
    }
    if (binding && command.action === 'request' && result.receipt?.outcome === 'applied') {
        if (result.receipt.appliedRevision !== command.request.target.expectedRevision + 1) { binding.valid = false; reply({ requestId: response.requestId, error: 'Invalid application revision' }); return; }
        binding.currentRevision = result.receipt.appliedRevision;
    }
    if (!binding || !result.inspection || !checkedInvoiceFormInspection(binding, result.inspection, owner())) {
        reply({ requestId: response.requestId, error: 'Actual form inspection or owner changed' }); return;
    }
    reply(response);
});
const ready = new Promise<void>(resolve => ipcMain.once('invoice-controls:ready', event => {
    if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) resolve();
}));
await window.loadFile(join(root, 'index.html')); await ready;
process.send?.({ ready: true });
process.on('message', raw => {
    const parsed = fillEnvelopeSchema.safeParse(raw); if (!parsed.success) return;
    const value = parsed.data, { command, requestId } = value;
    if (command.action === 'close') { reply({ requestId, result: { closed: true } }); window.destroy(); app.quit(); return; }
    if (pending) { reply({ requestId, error: 'Form control is busy' }); return; }
    if (command.action === 'request') {
        if (!binding || !matchesInvoiceFormTarget(binding, command.request, { ...owner(), epoch: command.epoch }) || !matchesInvoiceFormRun(binding, command.request, command.run)) {
            reply({ requestId, error: 'Form request owner or Run changed' }); return;
        }
        binding.runId = command.request.runId;
    }
    pending = { value, timer: setTimeout(() => { pending = null; reply({ requestId, error: 'Form control receipt is unknown' }); }, 3000) };
    window.webContents.send('invoice-controls:command', value);
});
process.on('disconnect', () => { window.destroy(); app.quit(); });
}
void start().catch(error => { process.stderr.write(String(error) + '\n'); app.exit(1); });
