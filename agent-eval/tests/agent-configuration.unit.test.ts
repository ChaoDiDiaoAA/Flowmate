import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as configuration from '../src/configuration.ts';
import type { ModelCatalogProvider } from '../../packages/contracts/src/settings.ts';
import { scanEvidence } from '../src/execution/evidence-safety.ts';
import { runJudge } from '../src/scoring/judges/harness.ts';
import { judgeConfig } from '../src/scoring/judges/client.ts';

const connection = { model: 'native-agent', api: 'openai-completions' as const, baseUrl: 'https://proxy.invalid/v1' };
function provider(id = 'native', endpoint = 'https://native.invalid/v1', contextWindow = 131072, maxTokens = 32768): ModelCatalogProvider {
    return { id, name: id, authMethods: ['api_key'], models: [{ id: connection.model, name: connection.model,
        api: connection.api, endpoint, contextWindow, maxTokens, reasoning: true }] };
}
function envRepo() {
    const root = mkdtempSync(join(tmpdir(), 'eval-agent-env-'));
    mkdirSync(join(root, 'agent-eval/configs'), { recursive: true });
    writeFileSync(join(root, 'agent-eval/configs/.env'), '# 评测专用主模型\nFLOWMATE_EVAL_AGENT_BASE_URL=https://proxy.invalid/v1\nFLOWMATE_EVAL_AGENT_MODEL=native-agent\nFLOWMATE_EVAL_AGENT_API_KEY=synthetic-eval-file-key\n');
    return root;
}

test('evaluation env accepts dedicated Agent variables without changing process or generic credentials', () => {
    const root = envRepo(), before = process.env.FLOWMATE_EVAL_AGENT_API_KEY;
    try {
        expect(configuration.evaluationEnv(root, {})).toMatchObject({ FLOWMATE_EVAL_AGENT_MODEL: 'native-agent' });
        expect(process.env.FLOWMATE_EVAL_AGENT_API_KEY).toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI model overrides preserve the selected endpoint credential and endpoint changes require an explicit connection credential', () => {
    const root = envRepo();
    try {
        const result = configuration.agentConfig?.(root, { FLOWMATE_EVAL_AGENT_MODEL: 'system-agent', FLOWMATE_EVAL_AGENT_API_KEY: 'synthetic-eval-system-key' },
            { model: 'cli-agent' });
        expect(result).toEqual({ configuration: { ...connection, model: 'cli-agent' }, apiKey: 'synthetic-eval-system-key' });
        expect(() => configuration.agentConfig(root, {}, { model: 'cli-agent', baseUrl: 'https://cli.invalid/v1', api: 'openai-responses' })).toThrow('credential');
        expect(configuration.agentConfig?.(root, {}).configuration).toEqual(connection);
        expect(scanEvidence('synthetic-eval-system-key').value).toBe('[REDACTED]');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the verified unauthenticated local Luna connection never inherits the default provider secret', () => {
    const root = envRepo();
    try {
        const result = configuration.agentConfig(root, {}, { model: 'gpt-6-luna', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1' });
        expect(result.apiKey).toBe('flowmate-local-no-auth'); expect(result.apiKey).not.toBe('synthetic-eval-file-key');
        expect(() => configuration.agentConfig(root, {}, { model: 'gpt-6-luna', api: 'openai-completions', baseUrl: 'https://unverified.invalid/v1' })).toThrow('credential');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the default Luna role carries configured max reasoning through preparation without using the experiment control credential', async () => {
    const root = envRepo();
    try {
        writeFileSync(join(root, 'agent-eval/configs/.env'), [
            'FLOWMATE_EVAL_AGENT_BASE_URL=http://127.0.0.1:8767/v1',
            'FLOWMATE_EVAL_AGENT_API=openai-completions', 'FLOWMATE_EVAL_AGENT_MODEL=gpt-6-luna',
            'FLOWMATE_EVAL_AGENT_REASONING_EFFORT=max', 'FLOWMATE_EVAL_DEEPSEEK_API_KEY=synthetic-experiment-control-key',
        ].join('\n'));
        const catalog: ModelCatalogProvider[] = [{ id: 'luna', name: 'Luna', authMethods: ['api_key'], models: [{
            id: 'gpt-6-luna', name: 'Luna', api: 'openai-completions', endpoint: 'http://127.0.0.1:8767/v1',
            contextWindow: 272000, maxTokens: 128000, reasoning: true,
        }] }];
        const prepared = await configuration.prepareAgentConfig(root, {}, {}, catalog);
        expect(prepared.configuration).toMatchObject({ model: 'gpt-6-luna', reasoning: 'max',
            api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1' });
        expect(prepared.apiKey).toBe('flowmate-local-no-auth');
        const { reasoning: _, modelCapabilities: __, ...localConnection } = prepared.configuration;
        expect((await configuration.prepareAgentConnection(localConnection, prepared.apiKey, catalog)).configuration.reasoning).toBe('max');
        expect((await configuration.prepareAgentConnection({ ...localConnection, reasoning: undefined }, prepared.apiKey, catalog)).configuration.reasoning).toBe('max');
        expect((await configuration.prepareAgentConfig(root, {}, { reasoning: 'off' }, catalog)).configuration.reasoning).toBe('off');
        expect(() => configuration.agentConfig(root, { FLOWMATE_EVAL_AGENT_REASONING_EFFORT: 'invalid' })).toThrow();
        expect(scanEvidence('synthetic-experiment-control-key').value).toBe('[REDACTED]');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('generic Agent, Judge, desktop and root dotenv credentials cannot substitute evaluation credentials', () => {
    const root = envRepo();
    try {
        writeFileSync(join(root, 'agent-eval/configs/.env'), '');
        writeFileSync(join(root, '.env'), 'FLOWMATE_EVAL_AGENT_API_KEY=synthetic-root-key\n');
        expect(configuration.agentConfig).toBeFunction();
        expect(() => configuration.agentConfig(root, { FLOWMATE_LLM_API_KEY: 'synthetic-generic-key', FLOWMATE_JUDGE_API_KEY: 'synthetic-judge-key' }, connection)).toThrow('FLOWMATE_EVAL_AGENT_API_KEY');
        for (const overrides of [{ model: '' }, { model: 'REPLACE_WITH_MODEL' }, { baseUrl: 'https://user:secret@invalid/v1' }, { baseUrl: 'https://valid.invalid/v1?key=secret' }, { api: 'guess-a-protocol' }])
            expect(() => configuration.agentConfig(root, { FLOWMATE_EVAL_AGENT_API_KEY: 'synthetic-only-key' }, { ...connection, ...overrides })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native limits are taken from the SDK catalog for direct endpoints and unambiguous proxies', () => {
    expect(configuration.resolveAgentModel?.(connection, [provider()])).toEqual({ contextWindow: 131072, maxTokens: 32768, reasoning: true,
        source: 'pi-sdk-model-catalog', providers: ['native'] });
    expect(configuration.resolveAgentModel?.({ ...connection, baseUrl: 'https://native.invalid/v1/' }, [provider(), provider('other', 'https://other.invalid', 262144, 65536)]))
        .toMatchObject({ contextWindow: 131072, maxTokens: 32768, providers: ['native'] });
    expect(configuration.resolveAgentModel?.(connection, [provider('b'), provider('a')])).toMatchObject({ providers: ['a', 'b'] });
});

test('unknown IDs, incompatible protocols, ambiguous or missing native limits have no fallback', () => {
    expect(configuration.resolveAgentModel).toBeFunction();
    for (const [selected, models] of [
        [{ ...connection, model: 'native-agent-alias' }, [provider()]],
        [{ ...connection, api: 'anthropic-messages' }, [provider()]],
        [connection, [provider(), provider('other', 'https://other.invalid', 262144)]],
        [connection, [provider('invalid', undefined, 0)]],
        [connection, [provider('fractional', undefined, 131072, 12.5)]],
        [connection, []],
    ] as const) expect(() => configuration.resolveAgentModel(selected, models)).toThrow();
});

test('preparing the Agent records catalog capabilities without a generation request', async () => {
    const root = envRepo();
    try {
        const result = await configuration.prepareAgentConfig?.(root, {}, {}, [provider()]);
        expect(result?.configuration).toEqual({ ...connection, modelCapabilities: { contextWindow: 131072, maxTokens: 32768, reasoning: true,
            source: 'pi-sdk-model-catalog', providers: ['native'] } });
        expect(JSON.stringify(result?.configuration)).not.toContain('synthetic-eval-file-key');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('verified local Luna uses its unique native cached context and the official model output limit', () => {
    const root = envRepo(), cache = join(root, 'models_cache.json');
    try {
        writeFileSync(cache, JSON.stringify({ models: [{ slug: 'gpt-6-luna', context_window: 272000,
            supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }] }] }));
        expect(configuration.readLocalCodexModelCapabilities({ model: 'gpt-6-luna', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1' }, cache))
            .toEqual({ contextWindow: 272000, maxTokens: 128000, reasoning: true,
                transport: { maxTokens: 32768, source: 'local-codex-gateway-source' },
                source: 'codex-cli-cache-and-openai-model-reference', providers: ['codex-cli-local-gateway'] });
        expect(() => configuration.readLocalCodexModelCapabilities({ model: 'gpt-6-luna', api: 'openai-completions', baseUrl: 'https://other.invalid/v1' }, cache)).toThrow();
        writeFileSync(cache, JSON.stringify({ models: [{ slug: 'gpt-6-luna', context_window: 1000, supported_reasoning_levels: [] }] }));
        expect(() => configuration.readLocalCodexModelCapabilities({ model: 'gpt-6-luna', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1' }, cache)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the local gateway transport ceiling applies without replacing supplied catalog native limits or provenance', async () => {
    const root = envRepo();
    try {
        const result = await configuration.prepareAgentConfig(root, {}, { model: 'gpt-6-luna', api: 'openai-completions', baseUrl: 'http://127.0.0.1:8767/v1' },
            [{ ...provider(), models: [{ ...provider().models[0]!, id: 'gpt-6-luna', endpoint: 'http://127.0.0.1:8767/v1', maxTokens: 128000 }] }]);
        expect(result.configuration.modelCapabilities).toMatchObject({ maxTokens: 128000, source: 'pi-sdk-model-catalog',
            transport: { maxTokens: 32768, source: 'local-codex-gateway-source' } });
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('uncatalogued DeepSeek uses exact provider metadata without guessing native limits or generating text', async () => {
    const root = envRepo(); let requests = 0;
    try {
        const result = await configuration.prepareAgentConfig(root, {}, { model: 'deepseek-flash' }, [], { fetcher: async (url, init) => {
            requests++;
            expect(url).toBe('https://proxy.invalid/v1/models');
            expect(init.method).toBe('GET');expect(init.body).toBeUndefined();
            expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-eval-file-key');
            return new Response(JSON.stringify({ data: [{ id: 'deepseek-flash', owned_by: 'deepseek', context_window: 1048576,
                max_output_tokens: 393216, effort: { supported_levels: ['low', 'high', 'max'] } }] }));
        } });
        expect(requests).toBe(1);expect(result.configuration.modelCapabilities).toEqual({ contextWindow: 1048576,
            maxTokens: 393216, reasoning: true, source: 'deepseek-models-api', providers: ['deepseek'] });
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing or malformed DeepSeek metadata and authentication errors have no hidden fallback', async () => {
    const root = envRepo();
    try {
        for (const response of [new Response('{}'), new Response(JSON.stringify({data:[{id:'other-model',owned_by:'deepseek'}]})),
            new Response(JSON.stringify({data:[{id:'deepseek-flash',owned_by:'deepseek',context_window:1024,max_output_tokens:0}]})),
            new Response('synthetic-eval-file-key', {status:401})]) {
            await expect(configuration.prepareAgentConfig(root, {}, {model:'deepseek-flash'}, [], {fetcher:async()=>response})).rejects.toThrow('metadata');
        }
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a DeepSeek Anthropic URL requires the declared Anthropic protocol before network access', () => {
    const root=envRepo();
    try { expect(()=>configuration.agentConfig(root,{}, {model:'deepseek-flash',baseUrl:'https://api.deepseek.com/anthropic',api:'openai-completions'}))
        .toThrow('FLOWMATE_EVAL_AGENT_API must be anthropic-messages'); }
    finally { rmSync(root,{recursive:true,force:true}); }
});

test('a credential embedded in public model fields is refused before doctor or snapshot can print it', () => {
    const root = envRepo();
    try {
        expect(() => configuration.agentConfig(root, {}, { baseUrl: 'https://proxy.invalid/v1/synthetic-eval-file-key' })).toThrow('credential');
        expect(() => configuration.agentConfig(root, {}, { model: 'synthetic-eval-file-key' })).toThrow('credential');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a dedicated key read from file is blocked from Judge input without any scoring request', async () => {
    const root = envRepo();
    try {
        configuration.agentConfig(root, {});
        const judge = judgeConfig({ FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'synthetic',
            FLOWMATE_JUDGE_BASE_URL: 'https://judge.invalid/v1', FLOWMATE_JUDGE_API_KEY: 'synthetic-separate-judge-key' }, root)!;
        let requests = 0;
        const result = await runJudge(judge, 'Score synthetic data.', 'synthetic-eval-file-key', async () => { requests++; throw Error('must not send'); });
        expect(requests).toBe(0);
        expect(result.error).toContain('secret');
        expect(JSON.stringify(result)).not.toContain('synthetic-eval-file-key');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('platform-only setup registers the file-only Agent key for supplemental export redaction', () => {
    const root = envRepo(), key = 'synthetic-main-key-only-platform-setup';
    try {
        writeFileSync(join(root, 'agent-eval/configs/.env'), 'FLOWMATE_EVAL_AGENT_API_KEY=' + key +
            '\nLANGFUSE_BASE_URL=https://platform.invalid\nLANGFUSE_PUBLIC_KEY=synthetic-platform-public\nLANGFUSE_SECRET_KEY=synthetic-platform-secret\n');
        configuration.langfuseConfig(root, {});
        expect(scanEvidence(key).value).toBe('[REDACTED]');
    } finally { rmSync(root, { recursive: true, force: true }); }
});
