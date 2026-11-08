import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assessCases, passingAssertionCount } from './report.ts';
import { scenarios, scenarioVersion } from './scenarios.ts';
import { DURABLE_SDK_VERSIONS } from '@flowmate/runtime-durable';
import { release } from 'node:os';

const root = resolve(import.meta.dir, '../..');
const args = process.argv.slice(2);
const suite = args.length === 0 ? 'smoke' : args[1];
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--suite' || !['smoke', 'full'].includes(suite))) {
  console.error('Usage: bun --no-env-file run eval:personal [--suite smoke|full]');
  process.exit(2);
}
const selected = Object.entries(scenarios).filter(([, item]) => item.suite === 'smoke' || suite === 'full')
  .map(([id, item]) => ({ id, ...item }));
const results = join(import.meta.dir, 'runs');
mkdirSync(results, { recursive: true });
const startedAt = new Date().toISOString();
const output = mkdtempSync(join(results, startedAt.replaceAll(':', '-').replace('.', '-') + '-'));
console.log(`Personal Agent evaluation results: ${output}`);

type Stage = { status: 'not-run' | 'running' | 'passed' | 'failed' | 'timed-out'; exitCode: number | null };
const stage = (): Stage => ({ status: 'not-run', exitCode: null });
const git = (args: string[]) => {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};
const status = git(['status', '--porcelain']);
const report = { schemaVersion: 2, scenarioVersion, suite, mode: 'synthetic-loopback', revision: git(['rev-parse', 'HEAD']),
  dirty: status === null ? null : status.length > 0, platform: process.platform, osRelease: release(), bun: Bun.version, sdk: DURABLE_SDK_VERSIONS,
  startedAt, endedAt: null as string | null, host: stage(), build: stage(), desktop: stage(),
  evidence: { status: 'not-run', passed: 0, required: selected.length }, regression: {} as Record<string, Stage> };
const save = () => writeFileSync(join(output, 'run.json'), JSON.stringify(report, null, 2) + '\n');
const env: Record<string, string> = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'ProgramData']) {
  if (process.env[key]) env[key] = process.env[key]!;
}
const evidencePath = join(output, 'checks.jsonl');
env.FLOWMATE_PERSONAL_CASE_EVIDENCE = evidencePath;

function saveEvidence(final = false) {
  const records = existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  }) : [];
  const evidence = assessCases(selected, records);
  const cases = evidence.cases.map(item => {
    const stage = item.stage === 'regression' ? report.regression[item.id] : report[item.stage];
    return item.state === 'not-run' && stage?.status === 'timed-out' ? { ...item, state: 'timed-out' } : item;
  });
  writeFileSync(join(output, 'cases.json'), JSON.stringify({ schemaVersion: 1, suite, cases }, null, 2) + '\n');
  report.evidence = { status: evidence.ok ? 'passed' : final ? 'failed' : 'not-run',
    passed: cases.filter(item => item.state === 'passed').length, required: selected.length };
  return evidence.ok;
}

async function run(current: Stage, args: string[], timeoutMs: number, artifact?: string, overrides?: Record<string, string>) {
  current.status = 'running';
  save();
  let timedOut = false;
  try {
    const child = Bun.spawn(args, { cwd: root, env: { ...env, ...overrides }, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' });
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try { current.exitCode = await child.exited; } finally { clearTimeout(deadline); }
    if (timedOut) throw Error(`Evaluation stage exceeded ${timeoutMs} ms.`);
    if (current.exitCode !== 0) throw Error(`Child process exited with code ${current.exitCode}.`);
    if (artifact && !existsSync(artifact)) throw Error('The test reporter did not save a result.');
    current.status = 'passed';
  } catch (error) {
    current.status = timedOut ? 'timed-out' : 'failed';
    throw error;
  } finally { saveEvidence(); save(); }
}

save();
try {
  const host = join(output, 'host.xml'), desktop = join(output, 'desktop.xml');
  await run(report.host, [process.execPath, '--no-env-file', 'test', '--isolate', '--reporter=junit', '--reporter-outfile=' + host,
    './agent-eval/personal-agent/personal-agent-eval.integration.test.ts'],
    selected.filter(item => item.stage === 'host').reduce((ms, item) => ms + item.timeoutMs, 10_000), host);
  await run(report.build, [process.execPath, '--no-env-file', 'run', 'build:desktop'], 120_000);
  const node = Bun.which('node');
  if (!node) {
    report.desktop.status = 'failed';
    throw Error('Electron evaluation requires Node.js.');
  }
  await run(report.desktop, [node, require.resolve('@playwright/test/cli'), 'test', '--workers=1', '--reporter=line,junit',
    '--output', join(output, 'desktop'), 'agent-eval/personal-agent/personal-agent-eval.e2e.test.ts'],
    selected.filter(item => item.stage === 'desktop').reduce((ms, item) => ms + item.timeoutMs, 10_000), desktop,
    { PLAYWRIGHT_JUNIT_OUTPUT_FILE: desktop });
  for (const item of selected) {
    if (item.stage !== 'regression') continue;
    const current = report.regression[item.id] = stage();
    const junit = join(output, item.id + '.xml');
    const pattern = '^' + item.title.replace(/[.*+?^$\{\}()|\[\]\\]/g, '\\$&') + '$';
    await run(current, [process.execPath, '--no-env-file', 'test', '--isolate', '--test-name-pattern', pattern,
      '--reporter=junit', '--reporter-outfile=' + junit, './' + item.file], item.timeoutMs, junit);
    const assertions = passingAssertionCount(readFileSync(junit, 'utf8'), item.title);
    if (!assertions) current.status = 'failed';
    appendFileSync(evidencePath, JSON.stringify({ id: item.id, version: item.version, state: current.status,
      checks: [{ id: 'required-regression', expected: true, actual: assertions > 0 }] }) + '\n');
    if (!assertions) throw Error(`Required regression did not pass: ${item.id}`);
    saveEvidence();
    save();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  report.endedAt = new Date().toISOString();
  if (!saveEvidence(true)) process.exitCode = 1;
  save();
}
