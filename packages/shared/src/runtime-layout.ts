import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import { resolveProductPaths, validateProductPaths } from './paths.ts';

export const PACKAGED_MIGRATIONS = ['001_provider.sql', '002_agent_sessions.sql', '003_invoice_tools.sql',
  '004_parsed_documents.sql', '005_native_session_history.sql', '006_hidden_processing.sql',
  '007_hidden_chats_invoices.sql', '008_native_entry_runs.sql', '009_session_inputs.sql', '010_human_candidates.sql',
  '011_session_management.sql', '012_tool_runtime_observations.sql', '013_runtime_events.sql',
  '014_workspace_selection.sql', '015_context_snapshots.sql', '016_native_history_commits.sql',
  '017_subagent_runs.sql', '018_subagent_parallel.sql', '019_research.sql', '020_direct_content.sql'] as const;

export const PACKAGED_NATIVE_TOOLS = { rg: { name: 'ripgrep', version: '15.2.0' }, fd: { name: 'fd', version: '10.4.2' } } as const;
export const PACKAGED_REQUIRED_FILES = ['bin/bun.exe', 'bin/photon_rs_bg.wasm', 'bin/rg.exe', 'bin/fd.exe',
  'licenses/ripgrep@15.2.0/LICENSE-MIT', 'licenses/fd@10.4.2/LICENSE-MIT', 'apps/host.js', 'apps/start-host.js',
  'apps/evaluation-worker.js', 'apps/start-evaluation.js', 'apps/maintenance.js', 'apps/image-resize-worker.js',
  'apps/fill-controls/main.mjs', 'apps/fill-controls/preload.cjs', 'apps/fill-controls/renderer.mjs', 'apps/fill-controls/index.html',
  'native/win32/prebuilds/win32-x64/win32-console-mode.node', 'sdk/package.json', 'sdk/README.md',
  'sdk/docs/sdk.md', 'sdk/dist/modes/interactive/theme/dark.json', 'sdk/dist/modes/interactive/theme/light.json',
  ...PACKAGED_MIGRATIONS.map(name => `apps/migrations/${name}`)] as const;

function isRuntimeMember(path: string): boolean {
  if (!path || path.length > 512 || /[\\:\x00-\x1f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return PACKAGED_REQUIRED_FILES.includes(path as typeof PACKAGED_REQUIRED_FILES[number])
    || /^(?:sdk\/(?:dist|docs)|native|resources|licenses)\/.+/.test(path);
}

export const PackagedReleaseSchema = z.object({
  version: z.literal(1), releaseId: z.string().uuid(), productVersion: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
  platform: z.literal('win32'), arch: z.literal('x64'),
  bunVersion: z.literal('1.4.0'), electronVersion: z.literal('44.4.5'), sdkVersion: z.literal('0.85.1'),
  pluginVersion: z.literal('0.19.0'), schemaVersion: z.literal(20), settingsVersion: z.literal(7),
  files: z.array(z.string().refine(isRuntimeMember)).min(PACKAGED_REQUIRED_FILES.length).max(20_000),
}).strict().superRefine((release, ctx) => {
  if (new Set(release.files).size !== release.files.length || PACKAGED_REQUIRED_FILES.some(file => !release.files.includes(file)))
    ctx.addIssue({ code: 'custom', message: 'Incomplete or duplicate runtime inventory.' });
});

export type PackagedRelease = Omit<z.infer<typeof PackagedReleaseSchema>, 'files'> & { files: readonly string[] };
export type RuntimeLayout = {
  mode: 'development' | 'installed';
  runtimeRoot: string; bunExecutable: string; hostLauncher: string; workerLauncher: string; maintenanceEntry: string;
  resourceRoot: string; sdkRoot: string; evaluationRoot: string; invoiceSourceRoot: string;
  release: PackagedRelease | null;
};

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
}

/** System paths from Main, never Renderer input. Installed mode has no source or PATH fallback. */
export function resolveRuntimeLayout(input: {
  isPackaged: boolean; appPath: string; resourcesPath: string; userDataRoot: string;
}): Result<RuntimeLayout> {
  const invalid = () => fail<RuntimeLayout>(appError('installation_runtime_invalid', 'runtime', 'Installed runtime layout or version is invalid.'));
  const missing = () => fail<RuntimeLayout>(appError('installation_dependency_missing', 'runtime', 'An installed runtime dependency is missing.'));
  if (![input.appPath, input.resourcesPath, input.userDataRoot].every(isAbsolute)) return invalid();
  if (!input.isPackaged) {
    let root = resolve(input.appPath);
    for (let depth = 0; depth < 4; depth++) {
      if (existsSync(join(root, 'apps/host/main.ts'))) break;
      root = dirname(root);
      if (depth === 3) root = resolve(input.appPath);
    }
    return ok({ mode: 'development', runtimeRoot: root,
      bunExecutable: process.env.FLOWMATE_BUN_EXECUTABLE?.trim() || 'bun', hostLauncher: join(root, 'apps/host/main.ts'),
      workerLauncher: join(root, 'agent-eval/src/desktop/worker.ts'), maintenanceEntry: join(root, 'apps/maintenance/main.ts'),
      resourceRoot: join(root, 'resources'), sdkRoot: join(root, 'node_modules/@earendil-works/pi-coding-agent'),
      evaluationRoot: root, invoiceSourceRoot: join(root, 'data/invoices/agent-input'), release: null });
  }
  if (process.platform !== 'win32' || process.arch !== 'x64') return invalid();
  try {
    const resources = realpathSync(input.resourcesPath), root = realpathSync(join(resources, 'flowmate-runtime'));
    const paths = resolveProductPaths(input.userDataRoot);
    if (!paths.ok) return invalid();
    const data = validateProductPaths(paths.data);
    if (!data.ok || !within(resources, root) || root === resources || within(resources, data.data.root)) return invalid();
    const manifest = join(root, 'release.json');
    if (!within(root, realpathSync(manifest)) || statSync(manifest).size > 2_000_000) return invalid();
    const parsed = PackagedReleaseSchema.safeParse(JSON.parse(readFileSync(manifest, 'utf8')));
    if (!parsed.success) return invalid();
    for (const file of parsed.data.files) {
      const target = join(root, file);
      if (!existsSync(target)) return missing();
      if (!within(root, realpathSync(target)) || !statSync(target).isFile() || statSync(target).size === 0) return invalid();
    }
    if (JSON.parse(readFileSync(join(root, 'sdk/package.json'), 'utf8')).version !== parsed.data.sdkVersion) return invalid();
    return ok({ mode: 'installed', runtimeRoot: root, bunExecutable: join(root, 'bin/bun.exe'),
      hostLauncher: join(root, 'apps/start-host.js'), workerLauncher: join(root, 'apps/start-evaluation.js'),
      maintenanceEntry: join(root, 'apps/maintenance.js'), resourceRoot: join(root, 'resources'), sdkRoot: join(root, 'sdk'),
      evaluationRoot: join(input.userDataRoot, 'evaluation'), invoiceSourceRoot: join(input.userDataRoot, 'imports/invoices'),
      release: parsed.data });
  } catch { return invalid(); }
}
