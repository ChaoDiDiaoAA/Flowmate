import { expect } from 'bun:test';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { defaultProductSettings } from '@flowmate/core';
import { RUNTIME_CONFIG, type Result, type DocumentSnapshot, type ProviderConfig } from '@flowmate/contracts';
import * as P from '../../../packages/contracts/src/personal-agent.ts';
import { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { deferCleanup, mkdtempSync } from '../../../tests/support/resources.ts';

function need<T>(result: Result<T>): T { if (!result.ok) throw Error(result.error.code); return result.data; }
type Command = Parameters<HostClient['request']>[0];
export async function invoke<S extends z.ZodTypeAny>(client: HostClient, command: Command, schema: S): Promise<z.infer<S>> {
  return z.object({ ok: z.literal(true), data: schema }).strict().parse(await client.request(command, 5_000)).data;
}

export async function controlledHost(options: { tools?: P.PersonalAgentConfiguration['tools']; respond?: (requestCount: number) => Response | Promise<Response>; sourceText?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-personal-host-commands-')), client = new HostClient();
  const wire: Array<{ authorization: string | null; body: unknown }> = [], credentials: string[] = [];
  const key = 'synthetic-personal-host-key', credentialRef = '00000000000000000000000000000081';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    wire.push({ authorization: request.headers.get('authorization'), body: await request.json() });
    if (options.respond) return options.respond(wire.length);
    const response = { id: `personal-host-${wire.length}`, object: 'chat.completion.chunk', created: 1, model: 'personal-local-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Review the original invoice and supply clarification before continuing.' }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true)); deferCleanup(() => client.close());
  const credentialHandler = async (request: { operation: string; credentialRef: string }) => {
    expect(request.operation).toBe('read'); expect(request.credentialRef).toBe(credentialRef);
    credentials.push(request.credentialRef); return { ok: true, credential: { type: 'api_key', key } };
  };
  client.setCredentialHandler(credentialHandler);
  expect(await client.start(root, '0.1.0', resolve(import.meta.dir, '../../..'))).toMatchObject({ ok: true, data: { ready: true } });
  const profile = { id: 'personal-local', name: 'Personal local', credentialRef, kind: 'custom' as const, providerId: null,
    baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'personal-local-model', api: 'openai-completions',
    contextWindow: 64000, maxTokens: 8192, reasoning: false };
  expect(await client.request({ type: 'save_settings', settings: { ...defaultProductSettings(), version: 6, revision: 0,
    profile: { displayName: 'P18 controlled Host', theme: 'system' }, models: [profile], defaultModelId: profile.id,
    updatedAt: '2026-10-29T00:00:00.000Z' } })).toMatchObject({ ok: true, data: { revision: 1 } });
  const sourceText = options.sourceText ?? 'Controlled invoice total 113.00';
  const document = need(await client.request({ type: 'import_prepared_invoice_material', input: {
    contract: 'flowmate-prepared-invoice/v1', sample: 'personal-host-controlled', sourceText,
    original: { name: 'source.md', base64: Buffer.from(sourceText).toString('base64') },
    pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: sourceText, sourceIndex: 0, sourceType: 'prepared-text', bbox: null }] }],
  } }) as Result<DocumentSnapshot>);
  const original = await invoke(client, { type: 'personal_agent_get', input: {} }, P.PersonalAgentSnapshotSchema);
  const agent = await invoke(client, { type: 'personal_agent_update', input: { personalAgentId: original.personalAgentId,
    expectedRevision: original.revision, configuration: { ...original.configuration, modelId: profile.id,
      resources: { prompt: null, enabledSkills: [] }, extensions: { enabledExtensions: [] }, tools: options.tools ?? ['read_invoice_document'] } } }, P.PersonalAgentSnapshotSchema);
  expect(wire).toHaveLength(0); expect(credentials).toHaveLength(0);
  const provider: ProviderConfig = { version: 1, name: `desktop-${profile.name}`, revision: 1,
    modelRef: { provider: `flowmate-profile-${profile.id}`, model: profile.model }, credentialRef,
    native: { authPath: join(root, 'runtime/pi-desktop/auth.json'), modelsPath: null },
    connection: { baseUrl: profile.baseUrl, api: profile.api, contextWindow: profile.contextWindow,
      maxTokens: profile.maxTokens, reasoning: profile.reasoning }, parameters: { ...RUNTIME_CONFIG.provider } };
  return { root, client, document, agent, wire, credentials, key, provider, credentialHandler };
}
