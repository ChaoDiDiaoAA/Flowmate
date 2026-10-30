import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { syntheticNativeModel } from '../support/native-model.ts';

test('actual isolated Host applies the trusted experiment prompt and disables budget awareness in the model request', async () => {
  const requests: Record<string, unknown>[] = [], prompt = 'Only summarize the supplied synthetic evidence. Never invent facts.';
  const server = await createHttpProvider(async request => {
    const body = await request.json() as Record<string, unknown>; requests.push(body);
    if (Number(body.max_completion_tokens) > 32768) return new Response('invalid output token limit', { status: 400 });
    const chunk = (delta: unknown, finish: string | null) => 'data: ' + JSON.stringify({ id: 'controlled-host', model: 'controlled-host',
      choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    return new Response(chunk({ role: 'assistant', content: 'The supplied value is 42.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  let session: Awaited<ReturnType<typeof prepareHostTrial>> | undefined;
  try {
    session = await prepareHostTrial({ identity: { executionId: 'controlled-overrides', trialId: 'trial-1', caseId: 'prompt-fixture', caseVersion: 1 },
      directory: mkdtempSync(join(tmpdir(), 'flowmate-host-overrides-')), input: { prompt: 'Summarize this evidence: the supplied value is 42.', materials: [] },
      requires: ['agent'], configuration: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'controlled-host',
        modelCapabilities: { ...syntheticNativeModel, maxTokens: 128000, transport: { maxTokens: 32768, source: 'local-codex-gateway-source' } },
        systemPrompt: prompt, reasoning: 'off', controlledReplay: true,
        strategy: { budgetAwareness: false, statistics: false, experience: false } } }, new AbortController().signal,
      { repo: REPO_ROOT, credential: 'synthetic-host-key' });
    const result = await session.execute(AbortSignal.timeout(15000));
    expect(result.error).toBeUndefined(); expect(result.started).toBe(true); expect(requests).toHaveLength(1);
    expect(requests[0]!.max_completion_tokens).toBe(32768);
    expect(result.configuration.modelCapabilities).toMatchObject({ maxTokens: 128000, source: syntheticNativeModel.source,
      transport: { maxTokens: 32768, source: 'local-codex-gateway-source' } });
    expect(JSON.stringify(requests[0]!.messages)).toContain(prompt);
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('Runtime awareness (advisory');
    expect(requests[0]!.tools ?? []).toEqual([]);
    expect(result.evidence['trace-capture']?.present, JSON.stringify(result.evidence['trace-capture'])).toBe(true);
    const generation = result.observations.find(observation => observation.kind === 'generation');
    expect(generation?.input).toEqual(requests[0]);
    expect(generation?.output).toMatchObject({ stopReason: 'stop' });
  } finally { if (session) await session.close(); await server.stop(); }
}, 45000);
