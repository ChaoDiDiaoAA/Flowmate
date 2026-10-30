import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCurationService } from '../../src/curation/index.ts';
import { candidateConditions, candidateFile, traceFile } from '../../src/curation/store.ts';
import { decodeFile } from '../../src/dataset-loader/flat.ts';
const benchmarkFile = (base: string) => { const root = join(base, 'published/Benchmark-private-contract');
  return join(root, readdirSync(root).find(name => /^Version-001-\d{4}-\d{2}-\d{2}$/.test(name))!, 'benchmark.json'); };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0, 255, 128, 1]), Buffer.from('\n%%EOF')]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZB1sAAAAASUVORK5CYII=', 'base64');
async function fixture(binary = false) {
  const repo = mkdtempSync(join(tmpdir(), 'private-gold-')); roots.push(repo);
  const base = join(repo, 'agent-eval/src/datasets'), testing = join(repo, 'agent-eval/src/testing'), files = join(testing, 'fixtures');
  mkdirSync(base, { recursive: true }); mkdirSync(files, { recursive: true });
  const publicFiles = Array.from({ length: 5 }, (_, index) => ({ sample: 'public-' + index, file: 'source.md', text: 'Independent correct source ' + index }));
  const privatePaths = Array.from({ length: 5 }, (_, index) => 'references/private-' + (index + 1) + (binary && index < 3 ? index === 1 ? '.png' : '.pdf' : '.md'));
  const privateLocations = privatePaths.map(path => join(files, path.replaceAll('/', '--')));
  for (const [index, path] of privateLocations.entries()) writeFileSync(path, binary && index < 3 ? index === 1 ? png : pdf : 'PRIVATE_GOLD_' + index);
  for (const file of publicFiles) writeFileSync(join(files, 'materials--' + file.sample + '--' + file.file), file.text);
  const task = { id: 'FM-001', name: 'task_private_source_contract', category: 'task', difficulty: 'difficult', purpose: 'capability', source: 'hand-authored',
    input: { prompt: 'Return the correct source value.', fixture: { name: 'source-contract' } },
    expected: { success: ['Return the correct value.'], failure: ['Return a wrong value.'], maxToolCalls: 0, mustHaveEvidence: false, expectedAnswerHint: 'correct' },
    scoring: { deterministic: ['fact-check'], judge: [], manual: 'Pending review' }, risks: ['Data only'], tags: ['business'] };
  const gold = { values: {}, checks: [{ metric: 'fact-check', required: true, evidence: 'answer', path: [], equals: 'correct' }], opportunities: { 'task-success': 1 }, sources: privatePaths, basis: 'Independent original formal references.' };
  const scenario = { requires: ['agent'], materials: publicFiles.map(({ sample, file }) => ({ source: 'local-text', sample, file })),
    steps: [{ id: 'request', action: 'user-message', instruction: '$input' }], selection: { enabledSkills: [], enabledExtensions: [] } };
  writeFileSync(join(base, 'cases.ts'), 'export const flowmateAgentV1Dataset = ' + JSON.stringify({ version: 'v1', cases: [task] }) + ';');
  writeFileSync(join(base, 'gold.ts'), 'export const goldByCaseId = ' + JSON.stringify({ 'FM-001': gold }) + ';');
  writeFileSync(join(base, 'review.ts'), 'export const reviewByCaseId = {"FM-001":{"humanReview":"pending"}};');
  writeFileSync(join(testing, 'scenarios.ts'), 'export const scenariosByName = ' + JSON.stringify({ 'source-contract': scenario }) + ';');
  const service = createCurationService(repo), trace = service.saveTrace({ id: randomUUID(), revision: 1, source: { kind: 'product' }, entry: 'chats',
    startedAt: '2026-10-28T00:00:00Z', endedAt: '2026-10-28T00:00:01Z', input: { prompt: task.input.prompt }, output: { answer: 'wrong' }, status: 'FAIL', complete: true, gaps: [], configuration: {}, events: [], facts: {},
    materials: publicFiles.map((file, index) => ({ id: 'public-' + index, path: 'materials/' + file.sample + '/' + file.file, text: file.text })) });
  const candidate = service.saveCandidate({ id: randomUUID(), revision: 1, kind: 'regression', reuseCaseId: 'FM-001', traceRef: { id: trace.id, revision: 1 }, reason: 'Reuse unchanged formal contract.', sourceLabels: ['independent-source'], case: task, gold, scenario,
    bindings: [{ materialId: 'public-0', quote: 'correct', label: 'Independent condition', target: { kind: 'success', text: task.expected.success[0] } }, { materialId: 'public-0', quote: 'correct', label: 'Independent answer', target: { kind: 'answer', text: 'correct' } }],
    controls: { negative: { label: 'Original failure', evidence: { answer: { present: true, actual: 'wrong', source: 'Original Trace' } } }, positive: { label: 'Independent contract', evidence: { answer: { present: true, actual: 'correct', source: 'Original independent source' } } } },
    controlBindings: [{ control: 'negative', evidence: 'answer', path: [], source: { kind: 'trace', path: ['output', 'answer'] } }, { control: 'positive', evidence: 'answer', path: [], source: { kind: 'material', materialId: 'public-0', quote: 'correct' } }] });
  const validation = await service.validateCandidate(candidate.id, { expectedRevision: 1 }); expect(validation.status, JSON.stringify(validation.issues)).toBe('PASS');
  const approval = service.addFeedback({ operationId: randomUUID(), target: { kind: 'candidate-review', id: candidate.id, revision: 1 }, reviewer: 'Controlled human approval fixture', source: 'human', verdict: 'approve', note: 'Checked the independent contract and controls.' });
  const request = { operationId: randomUUID(), benchmarkId: 'private-contract', candidateIds: [candidate.id], approvals: [approval.id] };
  return { repo, base, service, trace, candidate, validation, approval, request, privatePaths, privateLocations };
}

test('a private-only formal source change expires validation and human approval before any benchmark version is committed', async () => {
  const value = await fixture(); writeFileSync(value.privateLocations[0]!, 'CHANGED_PRIVATE_SOURCE');
  expect(() => value.service.publish(value.request)).toThrow('validated');
  expect(existsSync(join(value.base, 'published/private-contract/v1/manifest.json'))).toBe(false);
  expect(candidateConditions(value.repo, value.service.readCandidate(value.candidate.id))).not.toEqual(value.validation.conditions);
  const fresh = await value.service.validateCandidate(value.candidate.id, { expectedRevision: 1 }); expect(fresh.status).toBe('PASS');
  expect(() => value.service.publish({ ...value.request, operationId: randomUUID() })).toThrow('human approval');
});

test('unchanged private sources bind validation and approval while a ten-file package reads without the current baseline or its private files', async () => {
  const value = await fixture();
  expect(value.validation.conditions).toEqual(value.approval.conditions);
  const publication = value.service.publish(value.request); expect(publication.members[0]).toMatchObject({ caseId: 'FM-001', caseVersion: 1 });
  const file = benchmarkFile(value.base), stored = JSON.parse(readFileSync(file, 'utf8'));
  expect(Object.keys(stored.dataset.files)).toHaveLength(10);
  expect(stored.dataset.inputs['FM-001']).toEqual(['materials/public-0/source.md', 'materials/public-1/source.md', 'materials/public-2/source.md',
    'materials/public-3/source.md', 'materials/public-4/source.md']);
  expect(readdirSync(join(file, '..'))).toEqual(['benchmark.json']);
  rmSync(join(value.base, 'cases.ts')); for (const path of value.privateLocations) rmSync(path);
  const loaded = value.service.loadPublishedBenchmark('private-contract', 1)[0]!;
  expect(Object.keys(loaded.embedded!.files)).toHaveLength(10); expect(loaded.embedded!.inputs['FM-001']).toHaveLength(5);
  expect(JSON.stringify(loaded.embedded!.inputs)).not.toContain('PRIVATE_GOLD_');
  expect(value.service.readTrace(value.trace.id)).toEqual(value.trace);
  expect(stored.reviews['FM-001'].humanApproval).toMatchObject({ id: value.approval.id, source: 'human', target: { revision: 1 } });
  const altered = stored.dataset.files[value.privatePaths[0]!];
  altered.content = Buffer.from('Changed saved private source').toString('base64'); altered.bytes = Buffer.byteLength('Changed saved private source');
  writeFileSync(file, JSON.stringify(stored));
  expect(() => value.service.loadPublishedBenchmark('private-contract', 1)).toThrow('conditions');
});

test('published contents remain runnable after draft, Trace and central feedback deletion and reject false approval sources', async () => {
  const value = await fixture(); value.service.publish(value.request);
  const file = benchmarkFile(value.base), stored = JSON.parse(readFileSync(file, 'utf8'));
  rmSync(candidateFile(value.repo, value.candidate.id)); rmSync(traceFile(value.repo, value.trace.id));
  rmSync(join(value.repo, 'agent-eval/feedback.json')); rmSync(join(value.base, 'cases.ts'));
  for (const path of value.privateLocations) rmSync(path);
  const loaded = value.service.loadPublishedBenchmark('private-contract', 1)[0]!;
  expect(loaded.cases[0]!.id).toBe('FM-001'); expect(Object.keys(loaded.embedded!.files)).toHaveLength(10);
  stored.reviews['FM-001'].humanApproval.source = 'agent'; writeFileSync(file, JSON.stringify(stored));
  expect(() => value.service.loadPublishedBenchmark('private-contract', 1)).toThrow('approval');
});

test('published binary sources exist once as attachments and hydrate unchanged after all draft sources are deleted', async () => {
  const value = await fixture(true); value.service.publish(value.request);
  const file = benchmarkFile(value.base), root = join(file, '..'), raw = readFileSync(file, 'utf8'), stored = JSON.parse(raw);
  const attachments = readdirSync(join(root, 'materials')).sort();
  expect(attachments).toEqual(['Material-001.pdf', 'Material-002.png']);
  expect(stored.dataset.files[value.privatePaths[2]!].file).toBe(stored.dataset.files[value.privatePaths[0]!].file);
  for (const [path, bytes] of [[value.privatePaths[0]!, pdf], [value.privatePaths[1]!, png]] as const) {
    const reference = stored.dataset.files[path];
    expect(reference.content).toBeUndefined(); expect(reference.file).toMatch(/^materials\/Material-00[12]\.(pdf|png)$/);
    expect(readFileSync(join(root, reference.file))).toEqual(bytes); expect(raw).not.toContain(bytes.toString('base64'));
  }
  expect(stored.dataset.files['materials/public-0/source.md'].content).toBeDefined();
  const attachedPdf = join(root, stored.dataset.files[value.privatePaths[0]!].file), damaged = Buffer.from(pdf); damaged[0] = 0;
  writeFileSync(attachedPdf, damaged);
  expect(() => value.service.loadPublishedBenchmark('private-contract', 1)).toThrow('conditions');
  writeFileSync(attachedPdf, pdf); value.service.publish(value.request);
  expect(readdirSync(join(root, 'materials')).sort()).toEqual(attachments);
  rmSync(candidateFile(value.repo, value.candidate.id)); rmSync(traceFile(value.repo, value.trace.id));
  rmSync(join(value.repo, 'agent-eval/feedback.json')); rmSync(join(value.base, 'cases.ts'));
  for (const path of value.privateLocations) rmSync(path);
  const loaded = value.service.loadPublishedBenchmark('private-contract', 1)[0]!;
  expect(loaded.cases[0]!.id).toBe('FM-001');
  expect(decodeFile(loaded.embedded!.files[value.privatePaths[0]!]).bytes).toEqual(pdf);
  expect(decodeFile(loaded.embedded!.files[value.privatePaths[1]!]).bytes).toEqual(png);
  expect(JSON.stringify(loaded.embedded!.inputs)).not.toContain(pdf.toString('base64'));
  stored.dataset.files[value.privatePaths[0]!].file = '../outside.pdf'; writeFileSync(file, JSON.stringify(stored));
  expect(() => value.service.loadPublishedBenchmark('private-contract', 1)).toThrow();
});

test('a private source changed during an asynchronous replay cannot overwrite validation with a new source proof', async () => {
  const value = await fixture(), service = createCurationService(value.repo, { replay: async () => {
    writeFileSync(value.privateLocations[0]!, 'Changed during controlled replay callback');
    return { status: 'FAIL', kind: 'controlled', reason: 'Controlled race fixture; no model invocation' };
  } });
  await expect(service.validateCandidate(value.candidate.id, { expectedRevision: 1, replay: true })).rejects.toThrow('changed during validation');
  expect(service.readCandidate(value.candidate.id).validation).toEqual(value.validation);
});
