import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApplication, type ApplicationOptions } from '../../apps/composition.ts';
import { openDatabase, createFileStore } from '@flowmate/core';
import { PiAgentAdapter } from '@flowmate/runtime-pi';
import type { AgentRunEvent, ProviderConfig, ResearchIntent, Result, SessionInputRequest } from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from './resources.ts';

export function researchNeed<T>(result: Result<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.data; }
export const researchPlan = { question: 'Compare three Agent deployment options.', scope: 'Selected local materials only.',
  dimensions: [{ id: 'cost', title: 'Cost', questions: [{ id: 'cost-1', question: 'What costs apply?', evidenceNeeded: ['Official pricing'] }] }],
  sourcePolicy: { web: false, domains: [], artifactIds: [], documentIds: [] },
  stopConditions: ['Each dimension has evidence or an explicit gap.'],
  execution: { budget: { maxModelCalls: 12, maxToolCalls: 24, toolTimeoutMs: 10000 }, timeoutMs: 60000, stopGraceMs: 5000 } };
type Request = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> };
type ToolReply = { tool: string; args: unknown; id: string; note?: string };
type Reply = { text: string } | ToolReply | { tools: ToolReply[] };
export async function researchFixture(respond: (request: Request, index: number) => Reply | Promise<Reply>,
  setup?: (db: import('bun:sqlite').Database) => void, options: Pick<ApplicationOptions, 'resourceDefaults' | 'toolDefinitions'> & { material?: string; parsedDocument?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-fixture-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  let documentId: number | null = null;
  if (setup || options.parsedDocument) {
    const store = researchNeed(openDatabase(paths));
    try {
      setup?.(store.db);
      if (options.parsedDocument) {
        const at = new Date().toISOString(), sourceKey = 'research-fixture', sourceRecordId = 'parsed-material', version = 'v1';
        const parsed = { formatVersion: 2, pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: options.parsedDocument,
          sourceIndex: 0, sourceType: 'synthetic', bbox: null }] }], completeness: { status: 'complete', checks: [], warnings: [] } };
        const published = researchNeed(await createFileStore(paths, store.documents).publish({ sourceKey, sourceRecordId, sourceVersion: version, at,
          original: { kind: 'original', primaryName: 'original.png', files: [{ name: 'original.png',
            bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64'), mimeType: 'image/png' }] },
          parsed: { kind: 'parsed', primaryName: 'parsed.json', files: [{ name: 'parsed.json', bytes: Buffer.from(JSON.stringify(parsed)), mimeType: 'application/json' }] } }));
        researchNeed(store.documents.register({ documentId: published.documentId, sourceKey, sourceRecordId, version,
          originalArtifact: { ...published.original, kind: 'original' }, parsedArtifact: { ...published.parsed, kind: 'parsed' }, status: 'available',
          metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['synthetic test'], licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
        documentId = published.documentId;
      }
    } finally { store.close(); }
  }
  const requests: Request[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Request; requests.push(body);
    const reply = await respond(body, requests.length);
    const chunk = (delta: object, reason: string | null = null) => `data: ${JSON.stringify({ id: 'research-fixture', model: 'research-fixture',
      choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
    const text = 'text' in reply ? chunk({ role: 'assistant', content: reply.text }) + chunk({}, 'stop')
      : chunk({ role: 'assistant', ...('note' in reply ? { content: reply.note } : {}), tool_calls: ('tools' in reply ? reply.tools : [reply]).map((tool, index) => ({ index, id: tool.id, type: 'function',
        function: { name: tool.tool, arguments: JSON.stringify(tool.args) } })) }) + chunk({}, 'tool_calls');
    return new Response(text + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const app = researchNeed(await createApplication({ paths, resourceDefaults: options.resourceDefaults, toolDefinitions: options.toolDefinitions, logger: { write: () => undefined, close: async () => undefined },
    agentFactory: tools => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
      credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-research-key' }) }));
  deferCleanup(() => app.close());
  const session = researchNeed(await app.createSession({ title: 'Research fixture' }));
  const material = options.material ? researchNeed(await app.importResearchMaterial({ title: 'Deployment evidence.md', format: 'markdown', text: options.material })) : null;
  const task = researchNeed(await app.createResearchTask({ sessionId: session.sessionId, title: 'Deployment comparison',
    sourcePolicy: { ...researchPlan.sourcePolicy, artifactIds: material ? [material.artifactId] : [], documentIds: documentId ? [documentId] : [] } }));
  const config: ProviderConfig = { version: 1, name: 'Research fixture', revision: 1,
    modelRef: { provider: 'research-fixture', model: 'research-fixture' }, native: { authPath: join(root, 'unused-auth.json'), modelsPath: null },
    connection: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', contextWindow: 64000, maxTokens: 4096 },
    parameters: { maxRetries: 0, maxRetryDelayMs: 1000 } };
  function request(sequence: number, research: ResearchIntent = { researchId: task.researchId, phase: 'planning', plan: null }) {
    return { sessionId: session.sessionId, clientSequence: sequence, mode: 'prompt' as const, text: 'Compare the deployment options.', config, research };
  }
  async function start(input: SessionInputRequest) {
    let finish!: (event: Extract<AgentRunEvent, { type: 'run_finished' }>) => void;
    const completion = new Promise<Extract<AgentRunEvent, { type: 'run_finished' }>>(resolve => { finish = resolve; });
    const accepted = await app.submitInput(input, { onEvent: event => { if (event.type === 'run_finished') finish(event); } });
    return { accepted, completion };
  }
  async function run(input: SessionInputRequest) { const started = await start(input); return { accepted: researchNeed(started.accepted), terminal: await started.completion }; }
  return { app, task, session, config, paths, requests, request, start, run };
}
