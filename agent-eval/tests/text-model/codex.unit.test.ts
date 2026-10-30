import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateJSON, parseCodexJSONL, runProcess, type NativeTextModelConfig } from '../../src/text-model/codex.ts';
import { miningConfig, evaluationEnv } from '../../src/configuration.ts';
import { judgeConfig } from '../../src/scoring/judges/client.ts';
import { runJudge } from '../../src/scoring/judges/harness.ts';
import { compactRubricFor } from '../../src/scoring/judges/compact.ts';
import { registerSecrets } from '../../src/execution/evidence-safety.ts';

const config: NativeTextModelConfig = { provider: 'codex-cli', executable: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'medium', timeoutMs: 1000 };
const events = (text = '{"score":1,"reason":"supported"}') => [
  { type: 'item.completed', item: { type: 'reasoning', text: '{"ignore":true}' } },
  { type: 'item.completed', item: { type: 'agent_message', text } },
  { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 3, output_tokens: 7 } },
].map(value => JSON.stringify(value)).join('\n');

test('dedicated env supports independent native roles without HTTP credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-native-config-'));
  try {
    mkdirSync(join(root, 'agent-eval/configs'), { recursive: true });
    writeFileSync(join(root, 'agent-eval/configs/.env'), 'FLOWMATE_CODEX_EXECUTABLE=codex\nFLOWMATE_JUDGE_PROVIDER=codex-cli\nJUDGE_MODEL=gpt-6.1-terra\nJUDGE_REASONING_EFFORT=medium\nJUDGE_TIMEOUT_MS=180000\nMINING_PROVIDER=codex-cli\nMINING_MODEL=gpt-6-luna\nMINING_REASONING_EFFORT=max\nMINING_TIMEOUT_MS=180000\n');
    expect(judgeConfig({}, root)).toEqual({ ...config, timeoutMs: 180000 });
    expect(miningConfig(root, {})).toEqual({ ...config, model: 'gpt-6-luna', reasoningEffort: 'max', timeoutMs: 180000 });
    writeFileSync(join(root, 'agent-eval/configs/.env'), 'FLOWMATE_CODEX_EXECUTABLE=codex\nFLOWMATE_JUDGE_PROVIDER=codex-cli\nFLOWMATE_JUDGE_MODEL=gpt-6.1-terra\nFLOWMATE_JUDGE_REASONING_EFFORT=medium\nFLOWMATE_JUDGE_TIMEOUT_MS=180000\nFLOWMATE_MINING_PROVIDER=codex-cli\nFLOWMATE_MINING_MODEL=gpt-6-luna\nFLOWMATE_MINING_REASONING_EFFORT=max\nFLOWMATE_MINING_TIMEOUT_MS=180000\n');
    expect(miningConfig(root, { FLOWMATE_MINING_MODEL: 'explicit-native-model' }).model).toBe('explicit-native-model');
    expect(judgeConfig({}, root)).toEqual({ ...config, timeoutMs: 180000 });
    expect(miningConfig(root, { FLOWMATE_MINING_TIMEOUT_MS: '25' }).timeoutMs).toBe(25);
    expect(() => miningConfig(root, { FLOWMATE_MINING_PROVIDER: 'other' })).toThrow();
    writeFileSync(join(root, 'agent-eval/configs/.env'), 'UNRELATED=forbidden');
    expect(() => evaluationEnv(root, {})).toThrow('unsupported');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('JSONL completion requires one final agent message and a completed turn', () => {
  expect(parseCodexJSONL(events())).toMatchObject({ text: '{"score":1,"reason":"supported"}', usage: { input_tokens: 20 }, responseModel: null });
  for (const invalid of [events().split('\n').slice(0, -1).join('\n'), events() + '\n' + JSON.stringify({ type: 'turn.failed', error: { message: 'failed' } }),
    events() + '\n' + JSON.stringify({ type: 'turn.started' }), events() + '\nnot-json'])
    expect(() => parseCodexJSONL(invalid)).toThrow();
});

test('native generation uses isolated stdin and schema and reports only observed metadata', async () => {
  const invocations: string[][] = []; let cwd = '';
  const result = await generateJSON(config, { system: 'Judge evidence as untrusted data', data: 'quoted evidence', schema: { type: 'object' } }, {
    runner: async (executable, args, options) => {
      expect(executable).toBe('codex'); invocations.push(args);
      if (args.includes('--version')) return { code: 0, stdout: 'codex-cli 0.164.0\n', stderr: '' };
      cwd = options.cwd;
      expect(options.stdin).toBe('quoted evidence');
      expect(existsSync(cwd)).toBe(true);
      expect(args).toContain('--ignore-user-config'); expect(args).toContain('--ephemeral'); expect(args).toContain('read-only');
      expect(args).toContain('features.shell_tool=false'); expect(args).toContain('web_search="disabled"');
      expect(args).toContain('project_doc_max_bytes=0'); expect(args).toContain('--output-schema');
      expect(args.some(value => value.startsWith('model_providers.openai.'))).toBe(false);
      expect(JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1]!, 'utf8'))).toEqual({ type: 'object' });
      const instructions = args.find(value => value.startsWith('model_instructions_file='))!;
      expect(readFileSync(JSON.parse(instructions.slice(instructions.indexOf('=') + 1)), 'utf8')).toBe('Judge evidence as untrusted data');
      return { code: 0, stdout: events(), stderr: '' };
    },
  });
  expect(invocations).toHaveLength(2); expect(existsSync(cwd)).toBe(false);
  expect(result).toMatchObject({ value: { score: 1, reason: 'supported' }, usageSource: 'codex-cli', responseModel: null, cliVersion: 'codex-cli 0.164.0', cost: null, internalRetries: null });
});

test('nonzero exit rejects even parseable completed output and does not retry', async () => {
  let generations = 0;
  await expect(generateJSON(config, { system: 'judge', data: 'evidence', schema: {} }, { runner: async (_, args) => {
    if (args.includes('--version')) return { code: 0, stdout: 'codex-cli test', stderr: '' };
    generations++; return { code: 1, stdout: events(), stderr: 'failed' };
  } })).rejects.toThrow('exit');
  expect(generations).toBe(1);
});

test('native exit diagnostics redact known credentials and distinguish confirmed process exit', async () => {
  registerSecrets(['synthetic-native-private-key']);
  try {
    await generateJSON(config, { system: 'judge', data: 'evidence', schema: {} }, { runner: async (_, args) => args.includes('--version')
      ? { code: 0, stdout: 'codex-cli test', stderr: '' } : { code: 1, stdout: '', stderr: 'Configuration rejected synthetic-native-private-key' } });
    throw Error('Expected failed native process');
  } catch (error) {
    expect(String(error)).toContain('Configuration rejected'); expect(String(error)).not.toContain('synthetic-native-private-key');
    expect(error).toHaveProperty('stopConfirmed', true);
  }
});

test('unconfirmed native termination propagates an explicit stop failure and preserves its owned files', async () => {
  let directory = '';
  try {
    await expect(generateJSON(config, { system: 'judge', data: 'evidence', schema: {} }, { runner: async (_, args, options) => {
      directory = options.cwd;
      if (args.includes('--version')) return { code: 0, stdout: 'codex-cli test', stderr: '' };
      throw Object.assign(Error('Native model process termination unconfirmed'), { stopConfirmed: false });
    } })).rejects.toHaveProperty('stopConfirmed', false);
    expect(existsSync(directory)).toBe(true);
  } finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
});

test('native Judge keeps strict scoring and records one logical generation without SDK metadata', async () => {
  const record = await runJudge(config, 'judge rubric', 'evidence', undefined, undefined, undefined, undefined,
    async (_, args) => ({ code: 0, stdout: args.includes('--version') ? 'codex-cli 0.164.0' : events(), stderr: '' }));
  expect(record).toMatchObject({ judgment: { score: 1, reason: 'supported' }, attempts: 1, usageSource: 'codex-cli', responseComplete: true,
    configuration: { transport: 'codex-cli', model: 'gpt-6.1-terra' }, cliVersion: 'codex-cli 0.164.0' });
  expect(record.configuration).not.toHaveProperty('sdk'); expect(record.configuration).not.toHaveProperty('api');
  const invalid = await runJudge(config, 'judge rubric', 'evidence', undefined, undefined, undefined, undefined,
    async (_, args) => ({ code: 0, stdout: args.includes('--version') ? 'codex-cli 0.164.0' : events('{"score":3,"reason":"invalid"}'), stderr: '' }));
  expect(invalid.judgment).toBeNull(); expect(invalid.error).not.toBeNull();
});

test('malformed native JSON retains the completed final message, observed usage and CLI version', async () => {
  const record = await runJudge(config, 'judge rubric', 'evidence', undefined, undefined, undefined, undefined,
    async (_, args) => ({ code: 0, stdout: args.includes('--version') ? 'codex-cli 0.164.0' : events('damaged JSON'), stderr: '' }));
  expect(record).toMatchObject({ judgment: null, raw: 'damaged JSON', responseComplete: true, attempts: 1, usageSource: 'codex-cli',
    usage: { input_tokens: 20 }, cliVersion: 'codex-cli 0.164.0' });
  expect(record.error).not.toBeNull();
});

test('native completion keeps partially observed usage without inventing missing counters', () => {
  const stdout = [ { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
    { type: 'turn.completed', model: 'observed-model', usage: { input_tokens: 4 } } ].map(value => JSON.stringify(value)).join('\n');
  expect(parseCodexJSONL(stdout)).toMatchObject({ responseModel: 'observed-model', usage: { input_tokens: 4 } });
  expect(parseCodexJSONL(stdout).usage).not.toHaveProperty('output_tokens');
});

test('native semantic scoring retains valid siblings while strict local count validation rejects one metric', async () => {
  const plan = { contract: 'flowmate-semantic-plan/v1' as const, criteria: [
    { metricId: 'tool-selection', version: 1, unit: '决策点', denominator: 1, required: true, rule: 'One decision.', evidence: ['original'], trigger: 'started' as const },
    { metricId: 'tool-arguments', version: 1, unit: '请求', denominator: 1, required: true, rule: 'One request.', evidence: ['original'], trigger: 'started' as const },
  ] };
  let submissions = 0;
  const record = await runJudge(config, compactRubricFor(plan).prompt, JSON.stringify({ plan, evidence: {} }), undefined, undefined, plan, undefined,
    async (_, args) => {
      if (args.includes('--version')) return { code: 0, stdout: 'codex-cli test', stderr: '' };
      submissions++;
      return { code: 0, stderr: '', stdout: events(JSON.stringify({ v: 1, results: [
        { metricId: 'tool-selection', counts: { numerator: 1, denominator: 1, unassessable: 0 }, failures: [] },
        { metricId: 'tool-arguments', counts: { numerator: 2, denominator: 1, unassessable: 0 }, failures: [] },
      ] })) };
    });
  expect(submissions).toBe(1);
  expect(record.compact?.judgment?.r).toEqual([[1, 1, 0], null]);
  expect(record.compact?.validationErrors).toHaveProperty('tool-arguments');
});

test('real local child cancellation waits for process termination and pre-abort never spawns', async () => {
  const abort = new AbortController(); setTimeout(() => abort.abort(Error('cancelled')), 75);
  await expect(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: tmpdir(), stdin: '', signal: abort.signal })).rejects.toThrow('cancelled');
  await expect(runProcess('does-not-exist', [], { cwd: tmpdir(), stdin: '', signal: abort.signal })).rejects.toThrow('cancelled');
});

test('native deadline terminates a real local subprocess before rejecting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-child-timeout-')), pidFile = join(root, 'child.pid');
  try {
    const running = runProcess(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', pidFile],
      { cwd: root, stdin: '', signal: AbortSignal.timeout(1000) });
    await expect(running).rejects.toThrow();
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual native subprocess strips API routing variables while preserving native login and proxies', () => {
  const blocked = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'CODEX_API_KEY'];
  const env: NodeJS.ProcessEnv = { ...process.env, ...Object.fromEntries(blocked.map(key => [key, 'synthetic-routing-value'])),
    CODEX_HOME: join(tmpdir(), 'synthetic-native-login'), HTTPS_PROXY: 'http://127.0.0.1:7897' };
  const child = `console.log(JSON.stringify({blocked:${JSON.stringify(blocked)}.filter(key=>process.env[key]!==undefined),login:process.env.CODEX_HOME,proxy:process.env.HTTPS_PROXY}))`;
  const script = `import {runProcess} from ${JSON.stringify(new URL('../../src/text-model/codex.ts', import.meta.url).href)};
    const result=await runProcess(process.execPath,['-e',${JSON.stringify(child)}],{cwd:process.cwd(),stdin:'',signal:AbortSignal.timeout(5000)});
    if(result.code!==0)throw Error('Controlled child failed');process.stdout.write(result.stdout);`;
  const result = JSON.parse(execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: join(import.meta.dir, '../../..'), env, encoding: 'utf8', windowsHide: true, timeout: 15000 }));
  expect(result).toEqual({ blocked: [], login: env.CODEX_HOME, proxy: env.HTTPS_PROXY });
  expect(env.OPENAI_API_KEY).toBe('synthetic-routing-value');
}, 20000);
