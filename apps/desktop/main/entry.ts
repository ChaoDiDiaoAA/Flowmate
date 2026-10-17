import { app, BrowserWindow } from 'electron';
import { realpathSync, mkdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveRuntimeLayout } from '../../../packages/shared/src/runtime-layout.ts';

const controlsFlag = '--flowmate-evaluation-controls';
const controlsIndex = process.argv.indexOf(controlsFlag);
if (controlsIndex >= 0) {
  try {
    const root = process.argv[controlsIndex + 1];
    if (!app.isPackaged || !process.connected || typeof process.send !== 'function'
      || process.argv.filter(value => value === controlsFlag).length !== 1 || !root || !isAbsolute(root)
      || !/^fill-controls-[0-9a-f-]{36}$/.test(basename(root)) || realpathSync(root) !== resolve(root)) throw Error('Invalid controls root');
    const layout = resolveRuntimeLayout({ isPackaged: true, appPath: app.getAppPath(), resourcesPath: process.resourcesPath, userDataRoot: root });
    if (!layout.ok) throw Error('Invalid controls runtime');
    const entry = join(layout.data.runtimeRoot, 'apps/fill-controls/main.mjs');
    process.argv = [process.execPath, entry, root];
    await import(/* @vite-ignore */ pathToFileURL(entry).href);
  } catch { process.stderr.write('[Flowmate] evaluation_controls_start_failed\n'); app.exit(1); }
} else {
  app.setName('Flowmate');
  const testRoot = !app.isPackaged && process.env.FLOWMATE_TEST_MODE === '1' ? process.env.FLOWMATE_TEST_USER_DATA_ROOT : undefined;
  const root = testRoot && isAbsolute(testRoot) ? testRoot : join(app.getPath('appData'), 'Flowmate');
  mkdirSync(root, { recursive: true }); app.setPath('userData', root);
  if (!app.requestSingleInstanceLock()) app.quit();
  else {
    if (process.platform === 'win32') app.setAppUserModelId('com.flowmate.desktop');
    app.on('second-instance', () => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
    });
    await import('./index.ts');
  }
}
