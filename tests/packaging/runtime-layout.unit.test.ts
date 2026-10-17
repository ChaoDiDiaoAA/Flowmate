import { describe, expect, it } from 'bun:test';
import { mkdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync } from '../support/resources.ts';
import { resolveRuntimeLayout } from '../../packages/shared/src/runtime-layout.ts';

const migrations = ['001_provider.sql', '002_agent_sessions.sql', '003_invoice_tools.sql', '004_parsed_documents.sql',
  '005_native_session_history.sql', '006_hidden_processing.sql', '007_hidden_chats_invoices.sql', '008_native_entry_runs.sql',
  '009_session_inputs.sql', '010_human_candidates.sql', '011_session_management.sql', '012_tool_runtime_observations.sql',
  '013_runtime_events.sql', '014_workspace_selection.sql', '015_context_snapshots.sql', '016_native_history_commits.sql',
  '017_subagent_runs.sql', '018_subagent_parallel.sql', '019_research.sql', '020_direct_content.sql'];

function installation() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-package-'));
  const resourcesPath = join(root, '安装 resources'), runtime = join(resourcesPath, 'flowmate-runtime');
  const files = ['bin/bun.exe', 'bin/photon_rs_bg.wasm', 'bin/rg.exe', 'bin/fd.exe',
    'licenses/ripgrep@15.2.0/LICENSE-MIT', 'licenses/fd@10.4.2/LICENSE-MIT', 'apps/image-resize-worker.js',
    'apps/fill-controls/main.mjs', 'apps/fill-controls/preload.cjs', 'apps/fill-controls/renderer.mjs', 'apps/fill-controls/index.html',
    'native/win32/prebuilds/win32-x64/win32-console-mode.node', 'apps/host.js', 'apps/start-host.js', 'apps/evaluation-worker.js',
    'apps/start-evaluation.js', 'apps/maintenance.js', 'sdk/package.json', 'sdk/README.md',
    'sdk/dist/modes/interactive/theme/dark.json', 'sdk/dist/modes/interactive/theme/light.json',
    'sdk/docs/sdk.md', 'resources/prompts/invoice/prompt.md', ...migrations.map(name => `apps/migrations/${name}`)];
  const release = { version: 1, releaseId: '7fcdf7d9-c2ed-4ac9-860d-98ee69ad7ceb', productVersion: '0.1.0',
    platform: 'win32', arch: 'x64',
    bunVersion: '1.4.0', electronVersion: '44.4.5', sdkVersion: '0.85.1', pluginVersion: '0.19.0',
    schemaVersion: 20, settingsVersion: 7, files } as const;
  for (const file of files) {
    const path = join(runtime, file); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file === 'sdk/package.json' ? JSON.stringify({ version: '0.85.1' }) : 'synthetic package asset');
  }
  const manifest = join(runtime, 'release.json');
  writeFileSync(manifest, JSON.stringify(release));
  const input = { isPackaged: true, appPath: join(resourcesPath, 'app.asar'), resourcesPath,
    userDataRoot: join(root, '用户 data') };
  return { root, runtime, manifest, release, input };
}

describe('P17 runtime layout', () => {
  it.each(['', 'not-created'])('rejects a data root redirected through a junction into installed resources: %s', suffix => {
    const fixture = installation(), target = join(fixture.runtime, 'aliased-data');
    mkdirSync(target); symlinkSync(target, fixture.input.userDataRoot, 'junction');
    expect(resolveRuntimeLayout({ ...fixture.input, userDataRoot: join(fixture.input.userDataRoot, suffix) }))
      .toMatchObject({ ok: false, error: { code: 'installation_runtime_invalid' } });
  });

  it('uses only fixed installed artifacts and independent writable roots, including spaces and Chinese', () => {
    const fixture = installation(), result = resolveRuntimeLayout(fixture.input);
    expect(result).toEqual({ ok: true, data: {
      mode: 'installed', runtimeRoot: fixture.runtime, bunExecutable: join(fixture.runtime, 'bin/bun.exe'),
      hostLauncher: join(fixture.runtime, 'apps/start-host.js'), workerLauncher: join(fixture.runtime, 'apps/start-evaluation.js'),
      maintenanceEntry: join(fixture.runtime, 'apps/maintenance.js'), resourceRoot: join(fixture.runtime, 'resources'),
      sdkRoot: join(fixture.runtime, 'sdk'), evaluationRoot: join(fixture.input.userDataRoot, 'evaluation'),
      invoiceSourceRoot: join(fixture.input.userDataRoot, 'imports/invoices'), release: fixture.release,
    } });
  });

  it.each(['bin/bun.exe', 'bin/rg.exe', 'bin/fd.exe', 'licenses/ripgrep@15.2.0/LICENSE-MIT', 'licenses/fd@10.4.2/LICENSE-MIT',
    'apps/host.js', 'apps/maintenance.js', 'sdk/package.json',
    'sdk/dist/modes/interactive/theme/dark.json', 'apps/migrations/020_direct_content.sql'])
  ('reports a missing packaged dependency instead of finding a development fallback: %s', file => {
    const fixture = installation(); rmSync(join(fixture.runtime, file));
    mkdirSync(join(fixture.root, 'apps/host'), { recursive: true });
    writeFileSync(join(fixture.root, 'apps/host/main.ts'), 'development fallback must not run');
    const result = resolveRuntimeLayout(fixture.input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('installation_dependency_missing');
  });

  it.each([{ bunVersion: '1.4.3' }, { sdkVersion: '0.84.0' }, { schemaVersion: 21 }, { settingsVersion: 8 },
    { arch: 'arm64' }, { platform: 'linux' }, { releaseId: 'not-an-id' }, { extra: 'untrusted' }])
  ('rejects an incompatible or malformed release: %j', change => {
    const fixture = installation(); writeFileSync(fixture.manifest, JSON.stringify({ ...fixture.release, ...change }));
    const result = resolveRuntimeLayout(fixture.input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('installation_runtime_invalid');
  });

  it.each(['../outside.js', 'C:/outside.js', 'apps/../outside.js', 'apps\\host.js', 'apps/host.js:stream', '.env'])
  ('rejects invalid inventory paths: %s', file => {
    const fixture = installation();
    writeFileSync(fixture.manifest, JSON.stringify({ ...fixture.release, files: [...fixture.release.files, file] }));
    const result = resolveRuntimeLayout(fixture.input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('installation_runtime_invalid');
  });

  it('does not trust a manifest omitting SQL or having duplicate members', () => {
    const fixture = installation();
    for (const files of [fixture.release.files.filter(file => !file.endsWith('019_research.sql')),
      [...fixture.release.files, 'apps/host.js']]) {
      writeFileSync(fixture.manifest, JSON.stringify({ ...fixture.release, files }));
      expect(resolveRuntimeLayout(fixture.input).ok).toBe(false);
    }
  });

  it('checks the copied SDK package version as well as the release declaration', () => {
    const fixture = installation(); writeFileSync(join(fixture.runtime, 'sdk/package.json'), '{"version":"0.84.0"}');
    const result = resolveRuntimeLayout(fixture.input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('installation_runtime_invalid');
  });

  it('rejects runtime directories and member junctions escaping the fixed resources root', () => {
    const fixture = installation(), outside = mkdtempSync(join(tmpdir(), 'flowmate-package-outside-'));
    const bin = join(fixture.runtime, 'bin');
    for (const name of ['bun.exe', 'photon_rs_bg.wasm', 'rg.exe', 'fd.exe']) rmSync(join(bin, name));
    rmdirSync(bin);
    writeFileSync(join(outside, 'bun.exe'), 'not the installed runtime'); symlinkSync(outside, bin, 'junction');
    expect(resolveRuntimeLayout(fixture.input).ok).toBe(false);
    const second = installation();
    // The runtime root itself must resolve under resources, even when all assets exist elsewhere.
    const third = mkdtempSync(join(tmpdir(), 'flowmate-package-link-'));
    symlinkSync(second.runtime, join(third, 'flowmate-runtime'), 'junction');
    expect(resolveRuntimeLayout({ ...second.input, resourcesPath: third }).ok).toBe(false);
  });

  it('ignores development launch and data overrides when installed', () => {
    const fixture = installation(), names = ['FLOWMATE_BUN_EXECUTABLE', 'FLOWMATE_TEST_MODE', 'FLOWMATE_TEST_USER_DATA_ROOT',
      'FLOWMATE_TEST_INVOICE_SOURCE_ROOT'] as const, old = names.map(name => process.env[name]);
    try {
      for (const name of names) process.env[name] = name === 'FLOWMATE_TEST_MODE' ? '1' : join(fixture.root, 'untrusted');
      const result = resolveRuntimeLayout(fixture.input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.bunExecutable).toBe(join(fixture.runtime, 'bin/bun.exe'));
        expect(result.data.evaluationRoot).toBe(join(fixture.input.userDataRoot, 'evaluation'));
        expect(result.data.invoiceSourceRoot).toBe(join(fixture.input.userDataRoot, 'imports/invoices'));
      }
    } finally { names.forEach((name, i) => { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; }); }
  });

  it('keeps development source, resource and evaluation paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-source-')); mkdirSync(join(root, 'apps/host'), { recursive: true });
    writeFileSync(join(root, 'apps/host/main.ts'), 'synthetic source entry');
    const result = resolveRuntimeLayout({ isPackaged: false, appPath: join(root, 'out/main'),
      resourcesPath: join(root, 'electron-resources'), userDataRoot: join(root, 'data-root') });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.runtimeRoot).toBe(root);
      expect(result.data.hostLauncher).toBe(join(root, 'apps/host/main.ts'));
      expect(result.data.workerLauncher).toBe(join(root, 'agent-eval/src/desktop/worker.ts'));
      expect(result.data.resourceRoot).toBe(join(root, 'resources'));
      expect(result.data.evaluationRoot).toBe(root);
      expect(result.data.release).toBeNull();
    }
  });
});
