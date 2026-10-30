import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { evaluationEnv, agentConfig, localAgentCredential, readLocalCodexModelCapabilities } from '../../src/configuration.ts';

test('the Sol control configuration is accepted separately from the default Luna Agent', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-sol-config-'));
    mkdirSync(join(repo, 'agent-eval/configs'), { recursive: true });
    writeFileSync(join(repo, 'agent-eval/configs/.env'), [
        'FLOWMATE_EVAL_AGENT_MODEL=gpt-6-luna', 'FLOWMATE_EVAL_AGENT_BASE_URL=http://127.0.0.1:8767/v1',
        'FLOWMATE_EVAL_CONTROL_MODEL=gpt-6.1-sol', 'FLOWMATE_EVAL_CONTROL_API=openai-completions',
        'FLOWMATE_EVAL_CONTROL_BASE_URL=http://127.0.0.1:8767/v1', 'FLOWMATE_EVAL_CONTROL_REASONING_EFFORT=max'
    ].join('\n'));
    const env = evaluationEnv(repo, {});
    expect(agentConfig(repo, env).configuration.model).toBe('gpt-6-luna');
    expect(agentConfig(repo, env, { model: env.FLOWMATE_EVAL_CONTROL_MODEL, api: env.FLOWMATE_EVAL_CONTROL_API,
        baseUrl: env.FLOWMATE_EVAL_CONTROL_BASE_URL, reasoning: env.FLOWMATE_EVAL_CONTROL_REASONING_EFFORT }).configuration)
        .toMatchObject({ model: 'gpt-6.1-sol', reasoning: 'max' });
});

test('Sol capabilities require an exact local model and preserve the gateway transport limit', () => {
    const repo = mkdtempSync(join(tmpdir(), 'eval-sol-metadata-')), cache = join(repo, 'models.json');
    writeFileSync(cache, JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', context_window: 500000,
        supported_reasoning_levels: [{ effort: 'max' }] }] }));
    const connection = { model: 'gpt-6.1-sol', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1' };
    expect(localAgentCredential(connection)).toBeString();
    expect(readLocalCodexModelCapabilities(connection, cache)).toMatchObject({ contextWindow: 500000, transport: { maxTokens: 32768 } });
    expect(localAgentCredential({ ...connection, baseUrl: 'https://other.example.com/v1' })).toBeNull();
    expect(() => readLocalCodexModelCapabilities({ ...connection, model: 'gpt-6.1-terra' }, cache)).toThrow(/exact identity/);
});
