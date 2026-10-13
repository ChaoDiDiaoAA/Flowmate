import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import type { AgentTrialSession } from '../../src/adapters/agent.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';

for (const [contextWindow, maxTokens] of [[131072, 32768], [262144, 65536]]) {
    test('isolated Host preserves native Agent capacities ' + contextWindow + '/' + maxTokens, async () => {
        let request: Record<string, unknown> | undefined;
        const server = await createHttpProvider(async incoming => {
            expect(incoming.headers.get('authorization')).toBe('Bearer synthetic-native-key');
            request = await incoming.json() as Record<string, unknown>;
            const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'native-synthetic',
                choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
            return new Response(chunk({ role: 'assistant', content: 'Synthetic native answer.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
                { headers: { 'content-type': 'text/event-stream' } });
        });
        const directory = mkdtempSync(join(tmpdir(), 'eval-native-agent-'));
        let session: AgentTrialSession | undefined;
        try {
            session = await prepareHostTrial({ identity: { executionId: 'synthetic-native', trialId: 'native-' + contextWindow, caseId: 'synthetic-native', caseVersion: 1 },
                directory, input: { prompt: 'Give a synthetic answer.', materials: [] }, requires: ['agent'],
                configuration: { model: 'synthetic-native', api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + server.port + '/v1',
                    modelCapabilities: { contextWindow, maxTokens, reasoning: false, source: 'pi-sdk-model-catalog', providers: ['synthetic'] } } },
                new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-native-key' });
            const settings = JSON.parse(readFileSync(join(directory, 'product/data/settings.json'), 'utf8'));
            expect(settings.models[0]).toMatchObject({ contextWindow, maxTokens });
            expect(settings.defaultModelId).toBe(settings.models[0].id);
            expect(JSON.stringify(settings)).not.toContain('synthetic-native-key');
            const result = await session.execute(AbortSignal.timeout(15000));
            expect(result.status).toBe('completed');
            expect(request?.max_tokens ?? request?.max_completion_tokens).toBe(maxTokens);
            expect(result.configuration).toMatchObject({ modelCapabilities: { contextWindow, maxTokens } });
        } finally { if (session) expect((await session.close()).actual).toMatchObject({ closed: true, stopped: true }); await server.stop(); }
    }, 30000);
}
