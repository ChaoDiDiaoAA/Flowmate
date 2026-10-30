import { expect, test } from 'bun:test';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareAgentConfig } from '../../src/configuration.ts';
import { createProductAgent } from '../../src/adapters/agent.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { codeIdentity, runtimeSourceConditions } from '../../src/execution/source.ts';
import { registerSecrets, protectedSecrets, scanEvidence } from '../../src/execution/evidence-safety.ts';

test('local Luna preparation and ProductAgent registration permit a complete real-source declaration', async () => {
  const prepared = await prepareAgentConfig(REPO_ROOT, {}, { model: 'gpt-6-luna', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1' },
    [{ id: 'controlled-luna-catalog', name: 'Controlled metadata only', authMethods: ['api_key'], models: [{ id: 'gpt-6-luna', name: 'Luna',
      api: 'openai-completions', endpoint: 'http://127.0.0.1:8767/v1', contextWindow: 272000, maxTokens: 128000, reasoning: true }] }]);
  expect(createProductAgent(REPO_ROOT, prepared.apiKey).readiness().ready).toBe(true);
  const identity = codeIdentity(REPO_ROOT);
  const conditions = runtimeSourceConditions(REPO_ROOT, identity);
  expect(conditions.files.some(file => file.path === 'agent-eval/src/configuration.ts')).toBe(true);
  expect(protectedSecrets()).not.toContain(prepared.apiKey);
  expect(scanEvidence(prepared.apiKey).value).toBe(prepared.apiKey);
}, 30000);

test('a real configured private credential embedded in source still refuses the declaration', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-source-credential-')), secret = 'flowmate-local-no-auth-private-' + randomUUID();
  execFileSync('git', ['init', '-q'], { cwd: root, windowsHide: true });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'],
    { cwd: root, windowsHide: true });
  mkdirSync(join(root, 'apps')); writeFileSync(join(root, 'apps/private.ts'), 'export const exposed = ' + JSON.stringify(secret));
  registerSecrets([secret]);
  const identity = codeIdentity(root);
  expect(() => runtimeSourceConditions(root, identity)).toThrow('Configured credential in execution source');
  expect(scanEvidence(secret).value).toBe('[REDACTED]');
});
