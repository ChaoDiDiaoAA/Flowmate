// Opt-in documentation capture. --check and --plan never launch Electron.
import assert from 'node:assert/strict';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { ElectronApplication, Locator, Page } from 'playwright';
import { z } from 'zod';
import { isWorkflowReadOnly, type EvaluationWorkflowRequest } from '../../packages/contracts/src/evaluation-workflow.ts';
import { traceFile, readTrace, readTraceState, readCandidate } from '../../agent-eval/src/curation/store.ts';

const uuid = z.string().uuid();
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const parametersSchema = z.object({
  repository: z.string().refine(isAbsolute).default(resolve(import.meta.dirname, '../..')),
  outputDirectory: z.string().refine(isAbsolute),
  successTraceId: uuid.optional(), failureTraceId: uuid.optional(), readbackTraceId: uuid.optional(),
  candidateId: uuid.optional(), experimentId: id.optional(), fullExperimentId: id.optional(),
  baselineId: id.optional(), armId: id.optional(), gateId: id.optional(), gateExperimentId: id.optional(),
  fullPlan: z.object({ benchmark: z.object({ selection: z.literal('full') }).passthrough() }).passthrough().optional(),
}).strict();
type Parameters = z.infer<typeof parametersSchema>;
type CaptureStep = { number: number; name: string; filename: string; view: string;
  evidence: 'saved-record' | 'preparation-only' | 'missing-id'; note: string; request?: EvaluationWorkflowRequest };

function buildCapturePlan(p: Parameters): CaptureStep[] {
  const step = (number: number, filename: string, name: string, view: string, evidence: CaptureStep['evidence'], note: string,
    request?: EvaluationWorkflowRequest): CaptureStep => ({ number, filename, name, view, evidence, note, ...(request ? { request } : {}) });
  const trace = (number: number, filename: string, name: string, traceId: string | undefined, view = 'trace-root') =>
    step(number, filename, name, view, traceId ? 'saved-record' : 'missing-id', 'Existing Trace only; original outcome and gaps remain visible.',
      traceId ? { action: 'trace.show', traceId } : undefined);
  const candidate = (number: number, filename: string, name: string, note: string) => step(number, filename, name, 'candidate',
    p.candidateId ? 'saved-record' : 'missing-id', note, p.candidateId ? { action: 'candidate.show', candidateId: p.candidateId } : undefined);
  return [
    step(1, '01-environment', 'Local Evaluation entry', 'configuration', 'preparation-only', 'Shows the actual application entry; does not run doctor or prove readiness.', { action: 'settings.get' }),
    step(2, '02-subject-models', 'Configured Subject role', 'configuration', 'saved-record', 'Displays saved role configuration, not a model probe.', { action: 'settings.get' }),
    step(3, '03-native-judge', 'Configured native Judge', 'configuration', 'saved-record', 'Does not call Judge or claim that calibration passed.', { action: 'settings.get' }),
    step(4, '04-mining-model', 'Configured mining role', 'configuration', 'saved-record', 'Does not start mining.', { action: 'settings.get' }),
    step(5, '05-langfuse-connection', 'Configured Langfuse connection', 'configuration', 'saved-record', 'Configured is not connected/verified; no external browser is opened.', { action: 'settings.get' }),
    step(6, '06-trace-switches', 'Current capture/upload/mining switches', 'switches', 'saved-record', 'Reads current values; never saves or toggles switches.', { action: 'settings.get' }),
    trace(7, '07-success-task', 'Saved source task', p.successTraceId),
    trace(8, '08-failure-task', 'Saved failure/blocking evidence', p.failureTraceId),
    step(9, '09-trace-filter', 'Trace list and filters', 'trace-list', 'saved-record', 'An isolated capture profile does not impersonate the original Activity namespace.', { action: 'trace.list' }),
    trace(10, '10-trace-root', 'Original Trace input/output', p.successTraceId),
    trace(11, '11-trace-children', 'Original trajectory and receipts', p.successTraceId, 'trace-trajectory'),
    { ...trace(12, '12-remote-readback', 'Saved Langfuse readback in Flowmate', p.readbackTraceId, 'trace-trajectory'),
      note: 'Reads the independent saved langfuse.json platformSnapshot, never overwrites the local original. This is Flowmate, not a Langfuse webpage; no pull/upload is invoked.' },
    candidate(13, '13-mine-candidate', 'Existing mined candidate', 'Shows an existing candidate and original traceRef; does not initiate or repeat mining.'),
    candidate(14, '14-independent-expected', 'Existing independent expectations', 'Displays the saved Case/Gold/source bindings without modifying their contents.'),
    candidate(15, '15-human-feedback', 'Saved feedback / approval preparation', 'Displays already saved feedback when present. No reviewer, verdict or approval is submitted.'),
    candidate(16, '16-edit-validate', 'Saved candidate revision and validation', 'No edit, validation or replay is run. NOT_RUN and blocked remain unchanged.'),
    step(17, '17-publish-benchmark', 'Published snapshots / publication preparation', 'benchmarks', 'preparation-only', 'Only lists existing publications; an empty list remains empty. No publication or human approval is created.', { action: 'benchmark.list' }),
    step(18, '18-smoke-comparison', 'Saved experiment state', 'experiment', p.experimentId ? 'saved-record' : 'missing-id', 'Only reads an existing experiment. Does not run Smoke or write a comparison.', p.experimentId ? { action: 'experiment.show', experimentId: p.experimentId } : undefined),
    step(19, '19-explicit-baseline', 'Saved explicit Baselines', 'baselines', 'saved-record', 'Lists actual Baselines; does not create one.', { action: 'baseline.list' }),
    p.gateId && p.gateExperimentId ? step(20, '20-gate-results', 'Saved Gate original — read only', 'original-record', 'saved-record',
      'Reads an existing Gate by its exact experiment/ID. Does not call gate.check or infer a new verdict.', { action: 'record.read', kind: 'gate', id: p.gateId, experimentId: p.gateExperimentId, part: 'record' })
      : step(20, '20-gate-results', 'Gate preparation — not executed', 'gate-form', 'preparation-only', 'No saved Gate ID pair supplied; captures configuration only and does not call gate.check.', { action: 'baseline.list' }),
    p.fullExperimentId ? step(21, '21-full-and-archive', 'Saved Full experiment / evidence identities', 'experiment', 'saved-record', 'Only reads the supplied Full experiment. Does not run Full, export, archive or claim release acceptance.', { action: 'experiment.show', experimentId: p.fullExperimentId })
      : p.fullPlan ? step(21, '21-full-and-archive', 'Full plan preview — not executed', 'experiment-preview', 'preparation-only',
        'Fills the supplied Full plan and invokes read-only experiment.preview. No Full run, export, archive, approval or release acceptance.', { action: 'experiment.preview', plan: p.fullPlan })
        : step(21, '21-full-and-archive', 'Saved Full experiment / evidence identities', 'experiment', 'missing-id', 'No actual Full experiment ID or preview plan supplied.'),
  ];
}

const escapeXML = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
type Arrow = { x: number; y: number; label: string };
function overlay(pngName: string, width: number, height: number, arrows: Arrow[], caption: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height + 64}" viewBox="0 0 ${width} ${height + 64}">
<defs><marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 Z" fill="#d62828"/></marker></defs>
<rect width="${width}" height="64" fill="white"/><text x="20" y="27" font-family="Segoe UI,sans-serif" font-size="18" fill="#111">${escapeXML(caption)}</text>
<text x="20" y="51" font-family="Segoe UI,sans-serif" font-size="14" fill="#555">Vector annotations; the referenced original PNG is unchanged.</text>
<image href="${escapeXML(pngName)}" x="0" y="64" width="${width}" height="${height}"/>
${arrows.map((arrow, index) => {
    const x = Math.max(24, Math.min(width - 24, arrow.x - 130)), y = Math.max(24, Math.min(height - 24, arrow.y - 65)) + 64;
    return `<line x1="${x}" y1="${y}" x2="${arrow.x}" y2="${arrow.y + 64}" stroke="#d62828" stroke-width="3" marker-end="url(#arrow)"/>
<circle cx="${x}" cy="${y}" r="15" fill="white" stroke="#d62828" stroke-width="3"/><text x="${x}" y="${y + 5}" text-anchor="middle" font-family="Segoe UI,sans-serif" font-size="15" fill="#b21f26">${index + 1}</text>
<title>${escapeXML(arrow.label)}</title>`;
  }).join('\n')}
</svg>\n`;
}

async function displayed(page: Page, action: string, expectedId?: string): Promise<Record<string, unknown>> {
  const loop = page.getByRole('region', { name: 'Evaluation loop', exact: true });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const detail = loop.locator('details').last();
    try {
      const title = await detail.locator('summary').textContent();
      if (title?.startsWith('Actual workflow result · ' + action + ' ·')) {
        const data: Record<string, unknown> = JSON.parse(await detail.locator('pre').textContent() ?? '{}');
        const value = data.trace ?? data.candidate ?? data.experiment;
        if (!expectedId || value && typeof value === 'object' && 'id' in value && value.id === expectedId) return data;
      }
    } catch { /* A record is still being read; do not resend its request. */ }
    await new Promise(done => setTimeout(done, 100));
  }
  throw Error('The requested saved record was not displayed: ' + action + (expectedId ? '/' + expectedId : ''));
}

async function openDetails(summary: Locator) {
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}

async function prepare(page: Page, step: CaptureStep, p: Parameters): Promise<{ targets: Array<{ label: string; locator: Locator }>; data: Record<string, unknown> }> {
  assert(step.request && isWorkflowReadOnly(step.request.action), 'Only declared read-only requests are allowed');
  const loop = page.getByRole('region', { name: 'Evaluation loop', exact: true });
  const button = (name: string) => loop.getByRole('button', { name, exact: true });
  if (['configuration', 'switches'].includes(step.view)) {
    await button('Refresh loop configuration').click();
    const data = await displayed(page, 'settings.get');
    const summary = loop.getByText('Configured roles and Langfuse · readiness is not quality', { exact: true });
    await openDetails(summary);
    const configuration = summary.locator('..').locator('pre');
    if (step.number === 5) await configuration.evaluate(element => { element.scrollTop = element.scrollHeight; });
    return { data, targets: step.view === 'switches' ? ['Capture product traces', 'Upload captured traces', 'Automatically mine candidates'].map(label => ({ label, locator: loop.getByLabel(label, { exact: true }) }))
      : [{ label: step.name, locator: step.number === 1 ? loop.getByRole('heading', { name: 'Evaluation loop', exact: true }) : configuration }] };
  }
  if (step.view.startsWith('trace')) {
    await button('Traces').click(); await button('Refresh traces').click();
    let data = await displayed(page, 'trace.list');
    if (step.view === 'trace-list') return { data, targets: [{ label: 'Trace list', locator: loop.getByRole('heading', { name: 'Captured traces', exact: true }) },
      { label: 'Filter controls', locator: loop.getByRole('combobox', { name: /Trace entry filter/ }) }] };
    assert(step.request.action === 'trace.show');
    await loop.getByLabel('Trace UUID', { exact: true }).fill(step.request.traceId); await button('Read Trace by ID').click();
    data = await displayed(page, 'trace.show', step.request.traceId);
    const selected = loop.getByRole('region', { name: 'Selected trace', exact: true });
    const file = traceFile(p.repository, step.request.traceId);
    let original = file.includes('#') ? JSON.stringify({ ...readTrace(p.repository, step.request.traceId), ...readTraceState(p.repository, step.request.traceId) }, null, 2) + '\n'
      : readFileSync(file, 'utf8');
    if (step.number === 12) {
      assert(data.platformSnapshot, 'No independent saved platformSnapshot exists for this original Trace');
      const saved = readTraceState(p.repository, step.request.traceId).platformSnapshot;
      assert(saved?.trace.facts.langfuseObservations && Array.isArray(saved.trace.facts.langfuseObservations) && saved.trace.facts.langfuseObservations.length,
        'No original saved Langfuse observation rows exist; no verified readback will be claimed');
      original = JSON.stringify(saved, null, 2) + '\n';
      await selected.getByRole('button', { name: 'Read saved platform snapshot JSON', exact: true }).click();
    } else await selected.getByRole('button', { name: 'Read original Trace JSON', exact: true }).click();
    const reader = loop.getByRole('region', { name: 'Original record reader', exact: true });
    await reader.getByLabel('Original JSON chunk', { exact: true }).waitFor();
    if (step.view === 'trace-trajectory') {
      const key = step.number === 12 ? '"langfuseObservations"' : '"events"', offset = original.indexOf(key);
      assert(offset >= 0, 'Requested original trajectory field is missing');
      await reader.getByLabel('Original character offset', { exact: true }).fill(String(Math.max(0, offset - 5)));
      await reader.getByRole('button', { name: 'Read original offset', exact: true }).click();
      await reader.getByLabel('Original JSON chunk', { exact: true }).filter({ hasText: key }).waitFor();
    }
    data.captureReadRange = await reader.getByText(/^Characters /).textContent();
    return { data, targets: [{ label: 'Bounded original JSON chunk; not a full-record acceptance', locator: reader.getByLabel('Original JSON chunk', { exact: true }) },
      { label: 'Actual page range and redaction state', locator: reader.getByText(/^Characters /) }] };
  }
  if (step.view === 'candidate') {
    assert(step.request.action === 'candidate.show');
    await button('Candidates').click(); await button('Refresh candidates').click(); await displayed(page, 'candidate.list');
    await loop.getByLabel('Candidate UUID', { exact: true }).fill(step.request.candidateId); await button('Read candidate by ID').click();
    const data = await displayed(page, 'candidate.show', step.request.candidateId);
    const selected = loop.getByRole('region', { name: 'Selected candidate', exact: true });
    if (step.number === 14 || step.number === 16) {
      const candidate = data.candidate as { kind: string };
      assert(['gold', 'bad', 'regression'].includes(candidate.kind));
      const original = JSON.stringify(readCandidate(p.repository, step.request.candidateId), null, 2) + '\n', parsed = JSON.parse(original) as Record<string, unknown>;
      await selected.getByRole('button', { name: 'Read original candidate JSON', exact: true }).click();
      const reader = loop.getByRole('region', { name: 'Original record reader', exact: true });
      await reader.getByLabel('Original JSON chunk', { exact: true }).waitFor();
      const key = step.number === 14 ? '"gold"' : '"validation"', offset = original.indexOf(key);
      if (offset >= 0) {
        await reader.getByLabel('Original character offset', { exact: true }).fill(String(Math.max(0, offset - 5)));
        await reader.getByRole('button', { name: 'Read original offset', exact: true }).click();
        await reader.getByLabel('Original JSON chunk', { exact: true }).filter({ hasText: key }).waitFor();
      }
      data.captureReadRange = await reader.getByText(/^Characters /).textContent();
      data.originalGoldPresent = parsed.gold !== undefined; data.originalValidationPresent = parsed.validation !== undefined;
      return { data, targets: [{ label: 'Actual candidate original; missing Gold or validation is not supplied by this script', locator: reader.getByLabel('Original JSON chunk', { exact: true }) },
        { label: 'Explicit original chunk range', locator: reader.getByText(/^Characters /) }] };
    }
    return { data, targets: [{ label: 'Actual candidate revision and status', locator: selected.getByRole('heading') },
      { label: 'Saved independent source and validation', locator: selected.locator('details').first().locator('summary') }] };
  }
  if (step.view === 'original-record') {
    assert(step.request.action === 'record.read');
    const reader = loop.getByRole('region', { name: 'Original record reader', exact: true });
    await reader.getByLabel('Original record kind', { exact: true }).selectOption(step.request.kind);
    await reader.getByLabel('Original record ID', { exact: true }).fill(step.request.id);
    if (step.request.kind === 'gate') await reader.getByLabel('Original Gate experiment ID', { exact: true }).fill(step.request.experimentId!);
    await reader.getByRole('button', { name: 'Read known original record', exact: true }).click();
    await reader.getByText(new RegExp('^' + step.request.kind + ' ' + step.request.id + ' ·')).waitFor();
    const range = await reader.getByText(/^Characters /).textContent();
    const gate = JSON.parse(await reader.getByLabel('Original JSON chunk', { exact: true }).textContent() ?? '{}') as Record<string, unknown>;
    assert.equal(gate.id, step.request.id, 'Displayed Gate must match its original ID');
    return { data: { recordIdentity: { kind: step.request.kind, id: step.request.id, experimentId: step.request.experimentId }, gate, captureReadRange: range },
      targets: [{ label: 'Saved original Gate JSON; no new check was run', locator: reader.getByLabel('Original JSON chunk', { exact: true }) }] };
  }
  await button('Experiments').click();
  if (step.view === 'experiment-preview') {
    assert(step.request.action === 'experiment.preview');
    await loop.getByRole('region', { name: 'Experiment collection', exact: true }).locator('textarea').fill(json(step.request.plan));
    await button('Preview declared experiment').click();
    const data = await displayed(page, 'experiment.preview');
    const preview = data.preview as { plan?: { id?: string; benchmark?: { selection?: string } }; totalTrials?: number };
    assert.equal(preview.plan?.id, step.request.plan.id); assert.equal(preview.plan?.benchmark?.selection, 'full');
    const detail = loop.locator('details').last(), original = detail.locator('pre');
    await original.evaluate(element => { element.scrollTop = element.scrollHeight; });
    return { data, targets: [{ label: 'Actual Full preview; preparation only, no run', locator: detail.locator('summary') },
      { label: 'Actual planned Trials; no completed Full execution', locator: original }] };
  }
  if (step.view === 'experiment') {
    assert(step.request.action === 'experiment.show');
    await loop.getByLabel('Experiment ID', { exact: true }).fill(step.request.experimentId);
    await button('Read original experiment').click(); const data = await displayed(page, 'experiment.show', step.request.experimentId);
    const summary = loop.getByText('Actual experiment state and saved execution identities', { exact: true }), original = summary.locator('..').locator('pre');
    await original.evaluate(element => { element.scrollTop = element.scrollHeight; });
    return { data, targets: [{ label: 'Actual state and execution identities', locator: summary },
      { label: 'Saved experiment status and arm identities; no execution was started here', locator: original }] };
  }
  if (step.view === 'benchmarks') { await button('List published benchmarks').click(); }
  else { await button('List Baselines').click(); }
  const data = await displayed(page, step.request.action);
  if (step.view === 'gate-form') {
    if (p.experimentId) await loop.getByLabel('Experiment ID', { exact: true }).fill(p.experimentId);
    if (p.baselineId) await loop.getByLabel('Explicit Baseline ID', { exact: true }).fill(p.baselineId);
    if (p.armId) await loop.getByLabel('Arm ID', { exact: true }).fill(p.armId);
    return { data, targets: [{ label: 'Gate is not executed', locator: button('Check regression Gate') },
      { label: 'Explicit saved Baseline identity', locator: loop.getByLabel('Explicit Baseline ID', { exact: true }) }] };
  }
  return { data, targets: [{ label: 'Actual saved records; an empty list is not acceptance', locator: loop.locator('details').last().locator('summary') }] };
}

function evidenceSummary(data: Record<string, unknown>) {
  const result: Record<string, unknown> = { displayedKeys: Object.keys(data) };
  for (const name of ['trace', 'candidate', 'experiment']) {
    const value = data[name];
    if (value && typeof value === 'object') result[name] = Object.fromEntries(['id', 'revision', 'kind', 'status', 'complete', 'traceRef', 'attribution', 'arms']
      .filter(key => key in value).map(key => [key, Reflect.get(value, key)]));
  }
  if (Array.isArray(data.items)) result.items = data.items.map(item => item && typeof item === 'object'
    ? Object.fromEntries(['id', 'revision', 'status', 'experimentId', 'armId'].filter(key => key in item).map(key => [key, Reflect.get(item, key)])) : null);
  if (data.settings) result.settings = data.settings;
  if (data.preview) {
    const preview = data.preview as Record<string, unknown>;
    result.preview = Object.fromEntries(['plan', 'attribution', 'arms', 'caseCount', 'totalTrials'].filter(key => key in preview).map(key => [key, preview[key]]));
  }
  if (data.gate) result.gate = data.gate;
  if (data.page) result.page = data.page;
  if (data.recordIdentity) result.recordIdentity = data.recordIdentity;
  if (data.captureReadRange) result.captureReadRange = data.captureReadRange;
  if (data.originalGoldPresent !== undefined) result.originalGoldPresent = data.originalGoldPresent;
  if (data.originalValidationPresent !== undefined) result.originalValidationPresent = data.originalValidationPresent;
  if (data.platformSnapshot) {
    const snapshot = data.platformSnapshot as { readAt?: string; trace?: { id?: string; revision?: number; complete?: boolean; gapCount?: number } };
    result.platformSnapshot = { readAt: snapshot.readAt, traceId: snapshot.trace?.id, revision: snapshot.trace?.revision,
      complete: snapshot.trace?.complete, gapCount: snapshot.trace?.gapCount };
  }
  if (Array.isArray(data.feedback)) result.feedback = data.feedback.map(item => item && typeof item === 'object'
    ? Object.fromEntries(['id', 'target', 'source', 'verdict'].filter(key => key in item).map(key => [key, Reflect.get(item, key)])) : null);
  return result;
}

async function capture(p: Parameters) {
  const plan = buildCapturePlan(p), repository = realpathSync(p.repository), output = resolve(p.outputDirectory);
  assert(plan.every(step => !step.request || isWorkflowReadOnly(step.request.action)));
  assert(existsSync(join(repository, 'out/main/index.js')), 'Build desktop before capture');
  for (const step of plan) for (const extension of ['png', 'svg']) assert(!existsSync(join(output, step.filename + '.' + extension)), 'Refusing to overwrite a prior capture');
  assert(!existsSync(join(output, 'capture-index.json')), 'Choose a new output directory for a new capture');
  const ownRoot = mkdtempSync(join(tmpdir(), 'flowmate-evaluation-capture-')), link = join(ownRoot, 'evaluation-fixture');
  assert.equal(realpathSync(dirname(link)), realpathSync(ownRoot));
  symlinkSync(repository, link, 'junction'); assert.equal(realpathSync(link), repository);
  mkdirSync(output, { recursive: true });
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  const { _electron: electron } = await import('playwright');
  let app: ElectronApplication | undefined, failure: Error | undefined;
  const results: Record<string, unknown>[] = [];
  try {
    app = await electron.launch({ executablePath: join(repository, 'node_modules/electron/dist/electron.exe'), args: [join(repository, 'out/main/index.js')],
      env: { ...env, FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: ownRoot }, timeout: 30_000 });
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1600, height: 1100 });
    await page.getByRole('button', { name: 'Invoices', exact: true }).click(); await page.getByRole('heading', { name: 'Invoices', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Evaluation', exact: true }).click();
    for (const step of plan) {
      if (step.evidence === 'missing-id') { results.push({ ...step, captureStatus: 'skipped', reason: 'No actual record ID was provided.' }); continue; }
      try {
        const prepared = await prepare(page, step, p); await prepared.targets[0]!.locator.scrollIntoViewIfNeeded();
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        const points: Arrow[] = [], omitted: string[] = [];
        for (const target of prepared.targets) {
          const box = await target.locator.boundingBox();
          if (!box || box.y + box.height / 2 < 0 || box.y + box.height / 2 > viewport.height || box.x + box.width / 2 > viewport.width) { omitted.push(target.label); continue; }
          points.push({ x: box.x + box.width / 2, y: box.y + box.height / 2, label: target.label });
        }
        const png = join(output, step.filename + '.png'); await page.screenshot({ path: png });
        const bytes = readFileSync(png); assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        const arrows = points.map(point => ({ ...point, x: point.x * width / viewport.width, y: point.y * height / viewport.height }));
        writeFileSync(join(output, step.filename + '.svg'), overlay(basename(png), width, height, arrows,
          `${String(step.number).padStart(2, '0')} · ${step.name} · ${step.evidence}`), { flag: 'wx' });
        results.push({ ...step, captureStatus: 'captured', capturedAt: new Date().toISOString(), png: basename(png), svg: step.filename + '.svg',
          width, height, arrows, omittedArrows: omitted, observed: evidenceSummary(prepared.data) });
      } catch (error) { results.push({ ...step, captureStatus: 'failed', reason: error instanceof Error ? error.message : String(error) }); }
    }
  } catch (error) { failure = error instanceof Error ? error : Error(String(error)); throw failure; }
  finally {
    writeFileSync(join(output, 'capture-index.json'), json({ capturedAt: new Date().toISOString(), repository, ownRoot,
      scope: 'Read-only local Flowmate screenshots. No model execution, feedback, validation, publication, comparison, Gate, cloud browser or synthetic UI state.',
      preparationOnlyIsNotAcceptance: true, results }) + '\n', { flag: 'wx' });
    if (app) {
      const { closeDesktopFixture } = await import('../support/resources.ts'); await closeDesktopFixture(app, ownRoot, failure);
    }
  }
  console.log(json({ output, ownRoot, captured: results.filter(row => row.captureStatus === 'captured').length,
    incomplete: results.filter(row => row.captureStatus !== 'captured').length, retainedOwnedProfile: true }));
  if (results.some(row => row.captureStatus !== 'captured')) process.exitCode = 2;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

function selfCheck() {
  const minimal = parametersSchema.parse({ outputDirectory: resolve(tmpdir(), 'flowmate-capture-self-check') });
  const missing = buildCapturePlan(minimal);
  assert.equal(missing.length, 21, 'The plan must describe all 21 requested steps without inventing evidence');
  assert.equal(missing.find(step => step.number === 7)?.evidence, 'missing-id');
  assert.equal(missing.find(step => step.number === 20)?.evidence, 'preparation-only');
  assert(missing.every(step => !step.request || isWorkflowReadOnly(step.request.action)), 'A capture plan cannot submit business/model/publication writes');
  const traceId = '00000000-0000-4000-8000-000000000001';
  const supplied = buildCapturePlan({ ...minimal, successTraceId: traceId });
  assert.deepEqual(supplied.find(step => step.number === 7)?.request, { action: 'trace.show', traceId });
  const fullPlan = { id: 'controlled-full-preview', benchmark: { id: 'baseline', revision: 1, selection: 'full' }, repeats: 3,
    environment: 'development', axes: ['model'], control: { id: 'control' }, candidates: [{ id: 'candidate' }] };
  const full = buildCapturePlan(parametersSchema.parse({ ...minimal, fullPlan })).find(step => step.number === 21);
  assert.equal(full?.evidence, 'preparation-only');
  assert.deepEqual(full?.request, { action: 'experiment.preview', plan: fullPlan });
  assert.throws(() => parametersSchema.parse({ outputDirectory: '../relative' }));
  assert.throws(() => parametersSchema.parse({ outputDirectory: minimal.outputDirectory, apiKey: 'not-a-capture-parameter' }));
  const svg = overlay('original.png', 800, 600, [{ x: 400, y: 300, label: '<actual>' }], '<capture>');
  assert(svg.includes('<image href="original.png"'));
  assert(svg.includes('&lt;capture&gt;') && svg.includes('&lt;actual&gt;'));
  assert(!svg.includes('data:image') && !svg.includes('<script>'));
  console.log('Capture plan self-check passed; no Electron process or UI input was started.');
}

const args = parseArgs({ options: { check: { type: 'boolean' }, plan: { type: 'boolean' }, capture: { type: 'boolean' }, params: { type: 'string' } }, strict: true, allowPositionals: false });
assert.equal([args.values.check, args.values.plan, args.values.capture].filter(Boolean).length, 1, 'Choose exactly one of --check, --plan or --capture');
if (args.values.check) selfCheck();
else {
  assert(args.values.params, 'Provide --params <non-secret JSON file>');
  const parameters = parametersSchema.parse(JSON.parse(readFileSync(resolve(args.values.params), 'utf8')));
  if (args.values.plan) console.log(json({ parameters, steps: buildCapturePlan(parameters), uiStarted: false }));
  else await capture(parameters);
}
