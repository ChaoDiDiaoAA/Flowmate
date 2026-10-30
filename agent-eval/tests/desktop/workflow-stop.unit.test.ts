import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { createCurationService } from '../../src/curation/index.ts';
import { createEvaluationService } from '../../src/desktop/service.ts';
import { PACKAGED_REQUIRED_FILES, resolveRuntimeLayout, type PackagedRelease } from '@flowmate/shared';

test('installed runtime without a repository keeps Loop writes unavailable while saved Benchmark reads stay available', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-installed-loop-')), resources = join(root, 'resources'), runtimeRoot = join(resources, 'flowmate-runtime');
  const release: PackagedRelease = { version: 1, releaseId: crypto.randomUUID(), productVersion: '0.1.0', platform: 'win32', arch: 'x64',
    bunVersion: '1.4.0', electronVersion: '44.4.5', sdkVersion: '1.4.0', pluginVersion: '0.19.0', schemaVersion: 21, settingsVersion: 7,
    files: [...PACKAGED_REQUIRED_FILES] };
  for (const file of release.files) { mkdirSync(join(runtimeRoot, file, '..'), { recursive: true }); writeFileSync(join(runtimeRoot, file), 'controlled-release'); }
  writeFileSync(join(runtimeRoot, 'sdk/package.json'), JSON.stringify({ version: release.sdkVersion }));
  writeFileSync(join(runtimeRoot, 'release.json'), JSON.stringify(release));
  const layout = resolveRuntimeLayout({ isPackaged: true, appPath: join(resources, 'app.asar'), resourcesPath: resources, userDataRoot: join(root, 'profile') });
  if (!layout.ok) throw Error(layout.error.code);
  mkdirSync(layout.data.evaluationRoot, { recursive: true }); let models = 0;
  const service = createEvaluationService(layout.data.evaluationRoot, { runtime: { mode: 'installed', layout: layout.data, release },
    workflowDependencies: { generateJSON: async () => { models++; throw Error('No model call is authorized without a repository'); } } });
  const before = await service.workflow({ action: 'settings.get' });
  expect(before).toMatchObject({ ok: true, data: { data: { workspace: { available: false, reason: expect.stringContaining('repository') } } } });
  for (const request of [
    { action: 'settings.save', settings: { capture: true, upload: true, mining: true } },
    { action: 'mine', traceId: crypto.randomUUID(), expectedRevision: 1, operationId: crypto.randomUUID(), kind: 'gold' },
    { action: 'candidate.publish', operationId: crypto.randomUUID(), benchmarkId: 'controlled', candidateIds: [crypto.randomUUID()], approvals: [crypto.randomUUID()] },
  ]) expect(await service.workflow(request)).toMatchObject({ ok: false, error: { code: 'evaluation_workspace_unavailable' } });
  expect(models).toBe(0); expect(existsSync(join(layout.data.evaluationRoot, 'agent-eval/configs/observability.json'))).toBe(false);
  expect(existsSync(join(layout.data.evaluationRoot, 'agent-eval/src/datasets'))).toBe(false);
  expect(service.listExecutions({})).toMatchObject({ ok: true });
  expect(await service.workflow({ action: 'trace.list' })).toMatchObject({ ok: true });
  expect(await service.shutdown()).toMatchObject({ ok: true, data: { closed: true, stopped: true } });
});

test('unconfirmed native mining termination keeps desktop mutations and successful shutdown blocked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-workflow-stop-'));
  mkdirSync(join(root, 'agent-eval/configs'), { recursive: true });
  writeFileSync(join(root, 'agent-eval/configs/.env'), 'FLOWMATE_MINING_PROVIDER=codex-cli\nFLOWMATE_MINING_MODEL=gpt-6-luna\n');
  const traceId = '00000000-0000-4000-8000-000000000003';
  createCurationService(root).saveTrace({ id: traceId, revision: 1, source: { kind: 'product', runId: 'synthetic-run' }, entry: 'chats',
    startedAt: '2026-10-28T00:00:00.000Z', endedAt: '2026-10-28T00:00:01.000Z', input: { prompt: 'Original input' }, output: 'Original answer',
    status: 'completed', complete: true, gaps: [], configuration: {}, events: [], facts: {}, materials: [] });
  const service = createEvaluationService(root, { workflowDependencies: { nativeRunner: async (_executable, args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.164.0', stderr: '' };
    throw Object.assign(Error('Synthetic native termination remains unconfirmed'), { stopConfirmed: false });
  } } });
  const mined = await service.workflow({ action: 'mine', traceId, expectedRevision: 1, kind: 'bad',
    operationId: '00000000-0000-4000-8000-000000000004' });
  expect(mined).toMatchObject({ ok: true, data: { exitCode: 2, data: { operation: { status: 'unknown', stopConfirmed: false } } } });
  expect(await service.workflow({ action: 'settings.save', settings: { capture: true, upload: false, mining: false } }))
    .toMatchObject({ ok: false, error: { code: 'evaluation_busy' } });
  expect(await service.workflow({ action: 'trace.show', traceId })).toMatchObject({ ok: true });
  expect(await service.shutdown()).toMatchObject({ ok: true, data: { closed: false, stopped: false } });
});
