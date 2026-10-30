import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runJudge } from '../../src/scoring/judges/harness.ts';
import { saveReport, readReport, judgeCallSchema } from '../../src/reports/store.ts';
import { reportFixture } from '../support/fixtures.ts';

test('native Judge metadata round-trips without SDK fields or invented model/cost/retries', async () => {
  const call = await runJudge({ provider: 'codex-cli', executable: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'medium', timeoutMs: 1000 },
    'judge', 'evidence', undefined, undefined, undefined, undefined, async (_, args) => ({ code: 0, stderr: '',
      stdout: args.includes('--version') ? 'codex-cli 0.164.0' : [
        { type: 'item.completed', item: { type: 'agent_message', text: '{"score":1,"reason":"supported"}' } },
        { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } },
      ].map(value => JSON.stringify(value)).join('\n') }));
  expect(judgeCallSchema.safeParse(call).success).toBe(true);
  expect(judgeCallSchema.safeParse({ ...call, usageSource: 'sdk' }).success).toBe(false);
  expect(judgeCallSchema.safeParse({ ...call, cost: 0 }).success).toBe(false);
  expect(judgeCallSchema.safeParse({ ...call, configuration: { ...call.configuration, sdk: { ai: 'invented', codingAgent: 'invented' } } }).success).toBe(false);
  const root = mkdtempSync(join(tmpdir(), 'flowmate-native-report-'));
  try {
    const report = reportFixture(); report.contract = 'flowmate-agent-run/v2'; report.trials[0]!.judgeCalls = [call];
    report.scoringConfiguration.judge = call.configuration;
    saveReport(join(root, 'report.json'), report);
    const restored = readReport(join(root, 'report.json')).trials[0]!.judgeCalls[0]!;
    expect(restored).toMatchObject({ usageSource: 'codex-cli', responseModel: null, cost: null, internalRetries: null,
      configuration: { provider: 'codex-cli' }, cliVersion: 'codex-cli 0.164.0' });
    expect(restored.configuration).not.toHaveProperty('sdk');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
