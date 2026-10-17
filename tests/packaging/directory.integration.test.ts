import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../support/resources.ts';
import { resolveRuntimeLayout } from '@flowmate/shared';
import { ElectronInvoiceControls } from '../../agent-eval/src/adapters/electron-fill.ts';

const executable = process.env.FLOWMATE_P17_DIRECTORY_EXECUTABLE;
test.skipIf(!executable)('directory package runs isolated evaluation controls without product Main or a source build', async () => {
  if (!executable || !isAbsolute(executable) || basename(executable) !== 'Flowmate.exe' || !existsSync(executable)) throw Error('Explicit directory package executable is unavailable');
  const directory = dirname(executable), scene = mkdtempSync(join(tmpdir(), 'flowmate-目录 controls-'));
  const result = resolveRuntimeLayout({ isPackaged: true, appPath: join(directory, 'resources/app.asar'),
    resourcesPath: join(directory, 'resources'), userDataRoot: scene });
  expect(result.ok).toBe(true); if (!result.ok || !result.data.release) throw Error('Directory runtime is invalid');
  const controls = await ElectronInvoiceControls.start('missing-source-repository', scene,
    { mode: 'installed', layout: result.data, release: result.data.release });
  try {
    const opened = await controls.request({ action: 'open', epoch: 1, workspace: { revision: 1, sessionId: 1, jobId: 1,
      documentRef: { id: 1, version: 'independent-p17-synthetic' }, candidateRef: { id: 1, sequence: 1 } } });
    expect(opened.target?.formInstanceId).toBeString();
    expect((await controls.request({ action: 'inspect' })).inspection).toEqual(opened.inspection);
    expect(await controls.request({ action: 'close' })).toEqual({ closed: true });
  }
  finally { expect(await controls.close()).toMatchObject({ closed: true, stopped: true, exitCode: 0 }); }
  expect(existsSync(join(scene, 'data/app.sqlite'))).toBe(false);
  expect(existsSync(join(directory, 'data/app.sqlite'))).toBe(false);
}, 25_000);
