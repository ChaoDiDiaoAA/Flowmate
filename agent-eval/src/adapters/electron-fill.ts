import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fillCommandSchema, fillResultSchema, fillResponseSchema, type FillCommand } from './fill-controls/protocol.ts';
import type { z } from 'zod';
import type { EvaluationRuntime } from '../execution/source.ts';

/** This child owns controls and IPC only; the Trial retains its sole Host/database owner. */
export class ElectronInvoiceControls {
    private readonly pending = new Map<string, { resolve(value: z.infer<typeof fillResultSchema>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    private constructor(private readonly child: ChildProcess, private readonly exited: Promise<number | null>) {}
    static async start(repo: string, directory: string, runtime?: EvaluationRuntime) {
        const root = join(directory, 'fill-controls-' + randomUUID()); mkdirSync(root);
        const env: NodeJS.ProcessEnv = {};
        for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
        const installed = runtime?.mode === 'installed' ? runtime : null;
        if (installed) {
            for (const file of ['main.mjs', 'preload.cjs', 'renderer.mjs', 'index.html'])
                writeFileSync(join(root, file), readFileSync(join(installed.layout.runtimeRoot, 'apps/fill-controls', file)), { flag: 'wx' });
        } else {
        for (const [file, target, format] of [['main', 'node', 'esm'], ['preload', 'node', 'cjs'], ['renderer', 'browser', 'esm']] as const) {
            execFileSync('bun', ['--no-env-file', 'build', `agent-eval/src/adapters/fill-controls/${file}.ts`, '--target=' + target, '--format=' + format,
                '--external=electron', '--outfile', join(root, file + (format === 'cjs' ? '.cjs' : '.mjs'))], { cwd: repo, env, windowsHide: true, timeout: 30000 });
        }
        writeFileSync(join(root, 'index.html'), readFileSync(join(repo, 'agent-eval/src/adapters/fill-controls/index.html')), { flag: 'wx' });
        }
        const electron = installed ? join(installed.layout.runtimeRoot, '../../Flowmate.exe') : createRequire(join(repo, 'package.json'))('electron') as string;
        const child = spawn(electron, installed ? ['--flowmate-evaluation-controls', root] : [join(root, 'main.mjs'), root],
            { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
        const controls = new ElectronInvoiceControls(child, exited);
        let diagnostics = '';
        child.stdout!.resume();
        child.stderr!.on('data', bytes => { diagnostics = (diagnostics + bytes.toString().replaceAll(/libpng warning:[^\n]*\n/g, '')).slice(-8192); });
        try {
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('Electron controls startup is unconfirmed: ' + diagnostics)), 15000);
                const fail = (error: Error) => { clearTimeout(timer); reject(error); };
                child.once('error', fail); child.once('exit', () => fail(new Error('Electron controls exited before startup')));
                child.on('message', (raw: unknown) => {
                    if (raw && typeof raw === 'object' && 'ready' in raw && raw.ready === true) { clearTimeout(timer); resolve(); return; }
                    const response = fillResponseSchema.safeParse(raw); if (!response.success) return;
                    const pending = controls.pending.get(response.data.requestId); if (!pending) return;
                    clearTimeout(pending.timer); controls.pending.delete(response.data.requestId);
                    if (response.data.error) pending.reject(new Error(response.data.error)); else pending.resolve(response.data.result!);
                });
            });
        } catch (error) { child.kill(); const stopped = await controls.close();
            if (!stopped.stopped) throw new Error('Electron preparation failed and stopping is unconfirmed', { cause: error });
            throw error; }
        child.once('exit', code => { for (const item of controls.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Owned controls exited (' + code + '): ' + diagnostics)); } controls.pending.clear(); });
        return controls;
    }
    request(command: FillCommand): Promise<z.infer<typeof fillResultSchema>> {
        const checked = fillCommandSchema.parse(command), requestId = randomUUID();
        if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.connected) return Promise.reject(new Error('Owned controls are unavailable'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error('Form control receipt is unknown')); }, 5000);
            this.pending.set(requestId, { resolve, reject, timer });
            this.child.send({ requestId, command: checked }, error => {
                if (!error) return;
                clearTimeout(timer); this.pending.delete(requestId); reject(error);
            });
        });
    }
    async close() {
        if (this.child.exitCode === null && this.child.signalCode === null) {
            try { await this.request({ action: 'close' }); } catch { if (this.child.connected) this.child.disconnect(); }
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([this.exited.then(code => ({ closed: true, stopped: true, exitCode: code })),
            new Promise<{ closed: false; stopped: false }>(resolve => { timer = setTimeout(() => resolve({ closed: false, stopped: false }), 5000); })]);
        clearTimeout(timer); return result;
    }
}
