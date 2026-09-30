import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from 'electron-vite';
import { build, createServer as createViteServer, mergeConfig, type Rollup, type ViteDevServer } from 'vite';

export async function runDev(root = process.cwd()): Promise<void> {
  process.env.NODE_ENV_ELECTRON_VITE = 'development';
  const watchers: Rollup.RollupWatcher[] = [];
  const ready = new Set<string>();
  const building = new Set<string>();
  const http = createServer();
  let renderer: ViteDevServer | null = null;
  let desktop: ChildProcess | null = null;
  let desktopExit: Promise<void> = Promise.resolve();
  let confirmedClose = false;
  let stopInFlight: Promise<void> | null = null;
  let closing = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let readinessTimer: ReturnType<typeof setTimeout> | undefined;
  let rendererUrl = '';
  let initialization: Promise<void> = Promise.resolve();
  const require = createRequire(import.meta.url);
  const electronPackage = dirname(require.resolve('electron'));
  const executable = join(electronPackage, 'dist', readFileSync(join(electronPackage, 'path.txt'), 'utf8').trim());

  function deadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
    return new Promise((resolveWork, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop shutdown was not confirmed; restart is blocked.')), milliseconds);
      work.then(resolveWork, reject).finally(() => clearTimeout(timer));
    });
  }

  function stopDesktop(): Promise<void> {
    if (stopInFlight) return stopInFlight;
    const child = desktop;
    if (!child) return Promise.resolve();
    if (child.exitCode !== null || child.signalCode !== null) {
      return confirmedClose ? Promise.resolve() : Promise.reject(new Error('Desktop exited without confirmed cleanup.'));
    }
    stopInFlight = (async () => {
      const requestId = randomUUID();
      let receive!: (message: unknown) => void;
      const report = new Promise<void>((resolveClosed, reject) => {
        receive = (raw) => {
          if (!raw || typeof raw !== 'object') return;
          const message = raw as Record<string, unknown>;
          if (message.version !== 1 || message.type !== 'flowmate_dev_closed' || message.requestId !== requestId) return;
          if (message.closed === true && message.stopped === true) resolveClosed();
          else reject(new Error('Desktop shutdown was not confirmed; restart is blocked.'));
        };
        child.on('message', receive);
        child.send({ version: 1, type: 'flowmate_dev_shutdown', requestId }, (error) => { if (error) reject(new Error('Desktop shutdown channel is unavailable.')); });
      });
      try {
        await deadline(report, 15_000);
        await deadline(desktopExit, 5_000);
        confirmedClose = true;
        if (desktop === child) desktop = null;
      } finally { child.off('message', receive); }
    })().finally(() => { stopInFlight = null; });
    return stopInFlight;
  }

  async function finish(code = 0): Promise<void> {
    if (closing) return;
    closing = true;
    clearTimeout(restartTimer);
    clearTimeout(readinessTimer);
    await initialization;
    try { await stopDesktop(); }
    catch (error) { console.error(`[Flowmate dev] ${error instanceof Error ? error.message : 'Shutdown failed.'}`); code = 1; }
    const results = await Promise.allSettled([...watchers.map((watcher) => watcher.close()), renderer?.close()]);
    if (results.some((result) => result.status === 'rejected')) code = 1;
    http.closeAllConnections();
    if (http.listening) await new Promise<void>((resolveClosed) => http.close(() => resolveClosed()));
    process.exitCode = code;
    process.stdin.pause();
    if ((!desktop || desktop.exitCode !== null || desktop.signalCode !== null) && process.connected) process.disconnect();
  }

  function scheduleStart(): void {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (closing || building.size || ready.size !== 2 || desktop) return;
      confirmedClose = false;
      const args = [root];
      if (/^\d{1,5}$/.test(process.env.REMOTE_DEBUGGING_PORT ?? '')) args.push(`--remote-debugging-port=${process.env.REMOTE_DEBUGGING_PORT}`);
      const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RENDERER_URL: rendererUrl, FLOWMATE_DEV_PARENT: '1' };
      delete env.NODE_OPTIONS;
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, args, { cwd: root, detached: process.platform === 'win32',
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'], serialization: 'json',
        env });
      desktop = child;
      readinessTimer = setTimeout(() => {
        console.error('[Flowmate dev] Desktop startup did not become ready.');
        void finish(1);
      }, 30_000);
      desktopExit = new Promise<void>((resolveExited) => {
        child.once('exit', (code) => {
          clearTimeout(readinessTimer);
          resolveExited();
          if (!stopInFlight && !closing) void finish(confirmedClose ? code ?? 1 : 1);
        });
      });
      child.on('error', () => { console.error('[Flowmate dev] Desktop process failed.'); void finish(1); });
      child.on('message', (raw: unknown) => {
        if (!raw || typeof raw !== 'object') return;
        const message = raw as Record<string, unknown>;
        if (message.version !== 1) return;
        if (message.type === 'flowmate_dev_closed' && message.requestId === null && !stopInFlight)
          confirmedClose = message.closed === true && message.stopped === true;
        if (message.type === 'flowmate_dev_ready') {
          clearTimeout(readinessTimer);
          if (message.ready === true) console.log(`[Flowmate dev] Ready ${child.pid} ${rendererUrl}`);
          else { console.error('[Flowmate dev] Host startup failed.'); void finish(1); }
        }
      });
    }, 50);
  }

  process.on('SIGINT', () => { void finish(); });
  process.on('SIGTERM', () => { void finish(); });
  process.stdin.on('end', () => { void finish(); });
  process.stdin.resume();
  initialization = (async () => {
    const resolved = await resolveConfig({ root, envFile: false }, 'serve', 'development');
    const config = resolved.config;
    if (!config?.main || !config.preload || !config.renderer) throw new Error('Desktop development configuration is incomplete.');
    // Middleware mode leaves process signals and the HTTP lifetime with this launcher.
    renderer = await createViteServer(mergeConfig(config.renderer, { envFile: false, server: { middlewareMode: true, hmr: { server: http } } }));
    http.on('request', renderer.middlewares);
    await new Promise<void>((resolveListening, reject) => {
      http.once('error', reject);
      http.listen(config.renderer!.server?.port ?? 0, '127.0.0.1', resolveListening);
    });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Renderer server is unavailable.');
    rendererUrl = `http://127.0.0.1:${address.port}`;
    for (const name of ['main', 'preload'] as const) {
      const watcher = await build(mergeConfig(config[name]!, { build: { watch: {} }, plugins: [{
        name: 'flowmate-controlled-restart',
        async buildStart() {
          building.add(name);
          ready.delete(name);
          await stopDesktop();
        },
      }] }));
      if (!('on' in watcher)) throw new Error('Desktop build watcher is unavailable.');
      watchers.push(watcher);
      watcher.on('event', (event) => {
        if (event.code === 'ERROR') {
          building.delete(name);
          ready.delete(name);
          console.error(`[Flowmate dev] ${name} build failed; waiting for a successful rebuild.`);
        }
        if (event.code === 'BUNDLE_END') { building.delete(name); ready.add(name); scheduleStart(); }
      });
    }
  })().catch((error: unknown) => {
    console.error(`[Flowmate dev] ${error instanceof Error ? error.message : 'Development startup failed.'}`);
    void finish(1);
  });
  await initialization;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runDev();
