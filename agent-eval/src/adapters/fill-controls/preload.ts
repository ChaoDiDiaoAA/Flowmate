import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('invoiceControls', {
    receive: (handler: (value: unknown) => void) => ipcRenderer.on('invoice-controls:command', (_event, value: unknown) => handler(value)),
    reply: (value: unknown) => ipcRenderer.send('invoice-controls:reply', value),
    ready: () => ipcRenderer.send('invoice-controls:ready'),
});
