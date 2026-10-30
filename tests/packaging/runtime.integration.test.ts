import { expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { mkdtempSync, createHttpProvider, waitFor } from '../support/resources.ts';
import { buildRuntime } from '../../scripts/package.ts';
import { HostClient } from '../../apps/desktop/main/host-client.ts';
import { EvaluationClient } from '../../apps/desktop/main/evaluation-client.ts';
import { resolveRuntimeLayout } from '@flowmate/shared';
import { codeIdentity, runtimeSourceConditions, type EvaluationRuntime } from '../../agent-eval/src/execution/source.ts';
import { prepareLocalHost } from '../../agent-eval/src/adapters/local-host.ts';
import { manifest } from '../../agent-eval/tests/fixtures/minimal-dataset.ts';
import { readReport, reportPath } from '../../agent-eval/src/reports/store.ts';
import { ok } from '@flowmate/contracts';

it('refuses to create a runtime or installer when a required executable entry is missing', async () => {
  const repository = mkdtempSync(join(tmpdir(), 'flowmate-incomplete-source-'));
  mkdirSync(join(repository, 'apps/host'), { recursive: true });
  writeFileSync(join(repository, 'apps/host/main.ts'), 'export {};');
  const destination = join(repository, 'runtime-output');
  await expect(buildRuntime(repository, destination)).rejects.toThrow('packaging_entry_missing');
  expect(existsSync(destination)).toBe(false);
});

it('rejects an actual native executable of the wrong version before building a runtime', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-native-version-')), sdk = join(root, 'sdk'), destination = join(root, 'flowmate-runtime');
  mkdirSync(sdk); mkdirSync(join(root, 'bin')); copyFileSync(process.execPath, join(root, 'bin/rg.exe'));
  const previous = process.env.PI_PACKAGE_DIR;
  try {
    process.env.PI_PACKAGE_DIR = sdk;
    await expect(buildRuntime(fileURLToPath(new URL('../../', import.meta.url)), destination))
      .rejects.toThrow('packaging_native_tool_version_invalid');
  } finally { if (previous === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = previous; }
  expect(existsSync(destination)).toBe(false);
});

it('starts the real bundled Host with fixed assets and records its installed open outside the runtime root', async () => {
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const parent = mkdtempSync(join(tmpdir(), 'flowmate-安装 runtime-')), runtime = join(parent, 'flowmate-runtime');
  const secret = 'P17_SECRET_NOT_FOR_PACKAGING_973218', previous = process.env.FLOWMATE_EVAL_AGENT_API_KEY;
  let release;
  try { process.env.FLOWMATE_EVAL_AGENT_API_KEY = secret; release = await buildRuntime(repository, runtime); }
  finally { if (previous === undefined) delete process.env.FLOWMATE_EVAL_AGENT_API_KEY; else process.env.FLOWMATE_EVAL_AGENT_API_KEY = previous; }
  expect(release.files).toContain('bin/rg.exe'); expect(release.files).toContain('bin/fd.exe');
  expect(release.files).toContain('licenses/ripgrep@15.2.0/LICENSE-MIT'); expect(release.files).toContain('licenses/fd@10.4.2/LICENSE-MIT');
  expect(readFileSync(join(runtime, 'licenses/bun@1.4.4/LICENSE.md')).equals(readFileSync(join(repository, 'licenses/bun-1.4.4.LICENSE.md')))).toBe(true);
  for (const name of ['pi-ai', 'pi-agent-core', 'pi-coding-agent', 'pi-tui', 'pi-telemetry'])
    expect(readFileSync(join(runtime, `licenses/@earendil-works+${name}@1.4.0/LICENSE`)).equals(readFileSync(join(repository, 'licenses/pi-1.4.0.LICENSE')))).toBe(true);
  expect(release.files.some(file => /(^|\/)(gold|datasets?|fixtures|runs|\.env)(\/|$)/i.test(file))).toBe(false);
  for (const name of ['host.js', 'evaluation-worker.js', 'maintenance.js']) expect(readFileSync(join(runtime, 'apps', name), 'utf8')).not.toContain(secret);
  const imageWorker = Bun.spawn([join(runtime, 'bin/bun.exe'), '--no-env-file', '-e', `
    import {Worker} from 'node:worker_threads';
    const worker=new Worker(${JSON.stringify(join(runtime, 'apps/image-resize-worker.js'))});
    try { const message=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Image worker timeout')),5000);
      worker.once('message',value=>{clearTimeout(timer);resolve(value)});worker.once('error',error=>{clearTimeout(timer);reject(error)});
      worker.postMessage({inputBytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC','base64'),mimeType:'image/png'});
    }); process.stdout.write(JSON.stringify(message)); } finally {await worker.terminate();}
  `], { cwd: parent, env: {}, stdout: 'pipe', stderr: 'pipe' });
  const imageOutput = await new Response(imageWorker.stdout).text(), imageError = await new Response(imageWorker.stderr).text();
  expect({ code: await imageWorker.exited, stderr: imageError }).toEqual({ code: 0, stderr: '' });
  expect(JSON.parse(imageOutput)).toMatchObject({ result: { originalWidth: 1, originalHeight: 1, width: 1, height: 1, wasResized: false } });
  const data = mkdtempSync(join(tmpdir(), 'flowmate-独立 data-')), invoiceSource = join(data, 'imports/invoices');
  mkdirSync(invoiceSource, { recursive: true });
  const client = new HostClient();
  try {
    const keys = ['PATH', 'Path', 'FLOWMATE_BUN_EXECUTABLE'] as const, inherited = keys.map(key => process.env[key]);
    let started;
    try {
      delete process.env.PATH; delete process.env.Path;
      process.env.FLOWMATE_BUN_EXECUTABLE = join(parent, 'missing-development-bun.exe');
      started = await client.start(data, '0.1.0', data, invoiceSource, { executable: join(runtime, 'bin/bun.exe'),
        args: ['--no-env-file', join(runtime, 'apps/start-host.js'), '--user-data-root', data, '--invoice-source-root', invoiceSource] });
    } finally {
      keys.forEach((key, index) => { if (inherited[index] === undefined) delete process.env[key]; else process.env[key] = inherited[index]; });
    }
    expect(started).toMatchObject({ ok: true, data: { ready: true, appVersion: '0.1.0', userDataPath: data } });
    const native = await client.request({ type: 'query_native_tools' }) as { ok: boolean; data: { name: string; available: boolean }[] };
    expect(native.ok).toBe(true);
    expect(native.data.filter(tool => ['grep', 'find'].includes(tool.name))).toEqual([
      expect.objectContaining({ name: 'grep', available: true }), expect.objectContaining({ name: 'find', available: true })]);
    expect(existsSync(join(data, 'data/installed-release.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(data, 'data/installed-release.json'), 'utf8')).releaseId).toBe(release.releaseId);
    expect(existsSync(join(runtime, 'data/app.sqlite'))).toBe(false);
  } finally { expect(await client.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
  const db = new Database(join(data, 'data/app.sqlite'), { readonly: true });
  try {
    expect(db.query('SELECT MAX(version) AS version FROM schema_migrations').get()).toEqual({ version: 21 });
    expect(db.query('SELECT COUNT(*) AS count FROM runs').get()).toEqual({ count: 0 });
  } finally { db.close(); }
  const checked = resolveRuntimeLayout({ isPackaged: true, appPath: join(parent, 'app.asar'), resourcesPath: parent, userDataRoot: data });
  if (!checked.ok || !checked.data.release) throw Error('Installed layout unavailable');
  const evaluationRuntime: EvaluationRuntime = { mode: 'installed', layout: checked.data, release: checked.data.release };
  const source = codeIdentity(runtime, undefined, evaluationRuntime);
  expect(runtimeSourceConditions(runtime, source, evaluationRuntime).files.some(file => file.path === 'apps/host.js')).toBe(true);
  const evaluation = new EvaluationClient(runtime, checked.data.evaluationRoot, { executable: checked.data.bunExecutable,
    entry: checked.data.workerLauncher, cwd: runtime, runtime: evaluationRuntime });
  try {
    expect(await evaluation.catalog({ view: 'list' })).toMatchObject({ ok: true, data: { items: [] } });
    expect(await evaluation.listExecutions({})).toMatchObject({ ok: true });
    expect(existsSync(join(data, 'evaluation/agent-eval/runs'))).toBe(false);
  } finally { expect(await evaluation.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
  const scene = mkdtempSync(join(tmpdir(), 'flowmate-installed-trial-'));
  const trial = prepareLocalHost('not-a-source-repository', scene, [], undefined, undefined, [], evaluationRuntime);
  const trialClient = new HostClient();
  try { expect(await trialClient.start(trial.productRoot, '0.1.0', trial.runtimeRoot, trial.invoiceSourceRoot, trial.launch))
    .toMatchObject({ ok: true, data: { ready: true } }); }
  finally { expect(await trialClient.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); }
  expect(existsSync(join(trial.productRoot, 'data/installed-release.json'))).toBe(true);
  const datasetRoot = join(checked.data.evaluationRoot, 'agent-eval/src/datasets/p17-engineering');
  mkdirSync(join(datasetRoot, 'cases'), { recursive: true });
  writeFileSync(join(datasetRoot, 'dataset.json'), JSON.stringify({ ...manifest, id: 'p17-engineering', members: ['cases/synthetic.json'],
    smoke: ['synthetic'], scoring: { ...manifest.scoring, judges: [] } }));
  writeFileSync(join(datasetRoot, 'cases/synthetic.json'), JSON.stringify({ id: 'synthetic', version: 1, name: 'Installed engineering',
    category: 'engineering', tags: ['synthetic'], requires: ['agent'], input: { prompt: 'Return the synthetic answer 42.', materials: [] },
    expected: { success: ['Answer the synthetic request.'], failure: ['Invent an answer.'],
      checks: [{ metric: 'fact-check', required: true, evidence: 'answer', path: [], equals: 'The synthetic answer is 42.' }] }, review: { status: 'pending' } }));
  let calls = 0;
  const provider = await createHttpProvider(request => {
    calls++; expect(request.headers.get('authorization')).toBe('Bearer synthetic-p17-installed-agent');
    if (calls === 2) {
      const file = join(runtime, 'apps/evaluation-worker.js');
      writeFileSync(file, readFileSync(file, 'utf8') + '\n// Controlled source change during the second engineering Trial.\n');
    }
    if (calls === 3) unlinkSync(join(runtime, 'apps/host.js'));
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'p17-synthetic', model: 'deepseek-v4-flash',
      choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'The synthetic answer is 42.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  const runner = new EvaluationClient(runtime, checked.data.evaluationRoot, { executable: checked.data.bunExecutable,
    entry: checked.data.workerLauncher, cwd: runtime, runtime: evaluationRuntime });
  const settings = { revision: 1, agent: { api: 'openai-completions' as const, baseUrl: `http://127.0.0.1:${provider.port}/v1`, model: 'deepseek-v4-flash' },
    judge: null, credentials: { agent: 'configured' as const, judge: 'missing' as const } };
  try {
    for (const index of [1, 2, 3]) {
      const preview = await runner.preview({ datasetId: 'p17-engineering', selection: 'case', caseId: 'synthetic', repeat: 1, judge: 'off', configuration: {} }, settings);
      expect(preview).toMatchObject({ ok: true, data: { ready: true } }); if (!preview.ok) throw Error('Installed preview unavailable');
      const requestId = crypto.randomUUID();
      expect(await runner.start({ previewId: preview.data.previewId, requestId }, async () => ok({ settings,
        credentials: { agent: 'synthetic-p17-installed-agent', judge: null } }))).toMatchObject({ ok: true });
      await waitFor(async () => { const state = await runner.control({ requestId }); return state.ok && ['finished', 'stop-unconfirmed'].includes(state.data.state); }, 25_000);
      const state = await runner.control({ requestId });
      expect(state).toMatchObject({ ok: true, data: { state: 'finished', outcome: index === 1 ? 'completed' : 'failed', stop: 'confirmed' } });
      if (!state.ok || !state.data.executionIds[0]) throw Error('Installed Execution missing');
      const file = reportPath(checked.data.evaluationRoot, state.data.executionIds[0]);
      const report = readReport(file);
      expect(report.executionComplete).toBe(index === 1);
      expect(report.trials[0]!.status).toBe(index === 1 ? 'PASS' : 'ERROR');
      if (index === 2) expect(report.sourceInvalidation?.paths).toEqual(['apps/evaluation-worker.js']);
      if (index === 3) {
        expect(report.sourceInvalidation).toBeUndefined();
        expect(report.trials[0]!.reason).toBe('Execution source could not be rechecked; result is not verified');
        expect(report.trials[0]!.execution?.status).toBe('completed');
      }
    }
    expect(calls).toBe(3);
  } finally { expect(await runner.close()).toMatchObject({ ok: true, data: { closed: true, stopped: true } }); await provider.stop(); }
}, 60_000);
