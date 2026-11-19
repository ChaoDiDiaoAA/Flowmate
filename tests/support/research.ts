import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ApplicationOptions } from '../../apps/composition.ts';
import {
  ok, RESEARCH_SEMANTIC_POLICY_VERSION, ResearchSemanticReviewSchema, researchSemanticReportContext, researchSentences,
  type AgentRunEvent, type ProviderConfig, type ResearchIntent, type ResearchSemanticReviewIdentity,
  type ResearchSemanticReview, type ResearchSentence, type Result, type ReviewedResearchReportBody, type SessionInputRequest, type UsageRecordV1,
} from '@flowmate/contracts';
import { deferCleanup, mkdtempSync } from './resources.ts';

export function researchNeed<T>(result: Result<T>): T { if (!result.ok) throw new Error(JSON.stringify(result.error)); return result.data; }
export const researchPlan = { question: 'Compare three Agent deployment options.', scope: 'Selected local materials only.',
  dimensions: [{ id: 'cost', title: 'Cost', questions: [{ id: 'cost-1', question: 'What costs apply?', evidenceNeeded: ['Official pricing'] }] }],
  sourcePolicy: { web: false, domains: [], artifactIds: [], documentIds: [] },
  stopConditions: ['Each dimension has evidence or an explicit gap.'],
  execution: { budget: { maxModelCalls: 12, maxToolCalls: 24, toolTimeoutMs: 10000 }, timeoutMs: 60000, stopGraceMs: 5000 } };
export function citedSentence(text: string, claimIds: number[], evidenceIndex = 0): ResearchSentence {
  return { text, citations: claimIds.map(claimId => ({ claimId, evidenceIndex })) };
}

function supportedDecision({ text, citations }: ResearchSentence, sentenceIndex: number) {
  return { sentenceIndex, complete: true, facts: [{ start: 0, end: text.length, text, citations,
    verdict: 'supported' as const, reason: 'Controlled structural fixture verdict.' }],
    citationReviews: citations.map(citation => ({ ...citation, verdict: 'contributes' as const,
      reason: 'Controlled citation verdict.', contributions: [{ factIndex: 0, role: 'direct_support' as const,
        reason: 'The fixture citation directly supports the fact.' }] })) };
}

export function supportedResearchReviewResponse(text: string) {
  const separator = text.indexOf('\n\n');
  const json = separator >= 0 && !text.trimStart().startsWith('{') ? text.slice(separator + 2) : text;
  const { report, segment } = JSON.parse(json) as { report: Pick<ReviewedResearchReportBody, 'answer' | 'sections'>;
    segment?: { sourceSnapshotId: number; start: number; end: number } };
  if (segment) {
    const { sourceSnapshotId, start, end } = segment;
    return { sourceSnapshotId, start, end, complete: true, findings: [] };
  }
  return { sentences: researchSentences(report).map(supportedDecision) };
}

function controlledReviewMetadata(updatedAt: string) {
  return {
    model: { provider: 'research-fixture', model: 'research-fixture' }, responseId: 'research-fixture-review',
    usage: { version: 1, source: 'unknown', reason: 'fixture-usage-not-measured', sdkValues: null, attempts: 1,
      attemptsComplete: true, costSource: null, updatedAt } satisfies UsageRecordV1,
    tokens: { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, usageComplete: false },
  };
}

export async function controlledResearchReviewer({ text }: { text: string }) {
  return ok({ ...controlledReviewMetadata(new Date().toISOString()), text: JSON.stringify(supportedResearchReviewResponse(text)) });
}

export function createResearchReviewReceipt(report: ReviewedResearchReportBody,
  { researchId, planId, revision, runId, toolCallId, reviewedAt = new Date().toISOString() }: ResearchSemanticReviewIdentity & { reviewedAt?: string },
  evidenceBindings: NonNullable<ResearchSemanticReview['evidenceBindings']> = []) {
  const binding = { researchId, planId, revision, runId, toolCallId, reviewedAt, evidenceBindings,
    policyVersion: RESEARCH_SEMANTIC_POLICY_VERSION, reportContext: researchSemanticReportContext(report) };
  const sentences = researchSentences(report).map((sentence, index) => ({ ...sentence, ...supportedDecision(sentence, index), verdict: 'supported' }));
  const sources = [...new Map(evidenceBindings.map(({ source }) => [source.sourceSnapshotId, source])).values()];
  const context = { mode: 'full', segments: sources.map(({ sourceSnapshotId, characters }) => ({
    sourceSnapshotId, start: 0, end: characters, readStart: 0, readEnd: characters, complete: true, findings: [],
  })) };
  const metadata = controlledReviewMetadata(reviewedAt);
  return ResearchSemanticReviewSchema.parse(sentences.length
    ? { ...binding, ...metadata, context, stages: [{ stage: 'final', ...metadata }], status: 'verified', sentences }
    : { ...binding, context, stages: [], status: 'no_findings', sentences: [] });
}

type Request = { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown }> };
type ToolReply = { tool: string; args: unknown; id: string; note?: string };
type Reply = { text: string } | ToolReply | { tools: ToolReply[] };

function isReviewRequest({ tools, messages }: Request) {
  return !tools?.length && messages.some(({ role, content }) => {
    if (role !== 'system' || typeof content !== 'string') return false;
    const prompt = content.toLowerCase();
    return prompt.includes(RESEARCH_SEMANTIC_POLICY_VERSION) || (prompt.includes('independent') && prompt.includes('review'));
  });
}

export async function researchFixture(respond: (request: Request, index: number) => Reply | Promise<Reply>,
  setup?: (db: import('bun:sqlite').Database) => void, options: Pick<ApplicationOptions, 'resourceDefaults' | 'toolDefinitions' | 'researchPreferences' | 'memory' | 'researchWeb'> & {
    web?: boolean; material?: string; parsedDocument?: string; review?: (text: string) => object | Promise<object>; provider?: ApplicationOptions['provider'];
  } = {}) {
  // Playwright imports the response helper in Node; only the fixture loads Bun application modules.
  const [{ InMemoryCredentialStore }, { createApplication }, { createFileStore }, { openTestDatabase }, { PiAgentAdapter, PiProviderAdapter }] = await Promise.all([
    import('@earendil-works/pi-ai'), import('../../apps/composition.ts'), import('@flowmate/core'), import('./database.ts'), import('@flowmate/runtime-pi'),
  ]);
  const root = mkdtempSync(join(tmpdir(), 'flowmate-research-fixture-'));
  const paths = { root, databaseFile: join(root, 'data', 'app.sqlite'), artifactsDir: join(root, 'artifacts'),
    runtimeDir: join(root, 'runtime'), logsDir: join(root, 'logs'), outputsDir: join(root, 'outputs') };
  let documentId: number | null = null;
  if (setup || options.parsedDocument) {
    const store = researchNeed(openTestDatabase(paths));
    try {
      setup?.(store.db);
      if (options.parsedDocument) {
        const at = new Date().toISOString(), sourceKey = 'research-fixture', sourceRecordId = 'parsed-material', version = 'v1';
        const parsed = { formatVersion: 2, pages: [{ page: 1, blocks: [{ id: 'b1', kind: 'text', text: options.parsedDocument,
          sourceIndex: 0, sourceType: 'synthetic', bbox: null }] }], completeness: { status: 'complete', checks: [], warnings: [] } };
        const published = researchNeed(await createFileStore(paths, store).publish({ sourceKey, sourceRecordId, sourceVersion: version, at,
          original: { kind: 'original', primaryName: 'original.png', files: [{ name: 'original.png',
            bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=', 'base64'), mimeType: 'image/png' }] },
          parsed: { kind: 'parsed', primaryName: 'parsed.json', files: [{ name: 'parsed.json', bytes: Buffer.from(JSON.stringify(parsed)), mimeType: 'application/json' }] } }));
        researchNeed(store.documents.register({ documentId: published.documentId, sourceKey, sourceRecordId, version,
          originalArtifact: { ...published.original, kind: 'original' }, parsedArtifact: { ...published.parsed, kind: 'parsed' }, status: 'available',
          metadata: { version: 2, pageCount: 1, warnings: [], allowedUsesClaim: ['synthetic test'], licenseVerification: 'not_verified', unavailableReason: null }, createdAt: at, updatedAt: at }));
        documentId = published.documentId;
      }
    } finally { await store.close(); }
  }
  const requests: Request[] = [];
  const reviewRequests: Request[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Request;
    let reply: Reply;
    if (isReviewRequest(body)) {
      reviewRequests.push(body);
      const input = body.messages.find(message => message.role === 'user')?.content;
      if (typeof input !== 'string') return new Response('Expected reviewer user text.', { status: 400 });
      reply = { text: JSON.stringify(await (options.review ?? supportedResearchReviewResponse)(input)) };
    } else {
      requests.push(body);
      reply = await respond(body, requests.length);
    }
    const chunk = (delta: object, reason: string | null = null) => `data: ${JSON.stringify({ id: 'research-fixture', model: 'research-fixture',
      choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
    const text = 'text' in reply ? chunk({ role: 'assistant', content: reply.text }) + chunk({}, 'stop')
      : chunk({ role: 'assistant', ...('note' in reply ? { content: reply.note } : {}), tool_calls: ('tools' in reply ? reply.tools : [reply]).map((tool, index) => ({ index, id: tool.id, type: 'function',
        function: { name: tool.tool, arguments: JSON.stringify(tool.args) } })) }) + chunk({}, 'tool_calls');
    return new Response(text + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  deferCleanup(() => server.stop(true));
  const open = async () => {
  const opened = researchNeed(await createApplication({ paths, resourceDefaults: options.resourceDefaults, toolDefinitions: options.toolDefinitions, researchPreferences: options.researchPreferences, memory: options.memory, researchWeb: options.researchWeb, logger: { write: () => undefined, close: async () => undefined },
    provider: options.provider ?? new PiProviderAdapter({ credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-research-key' }),
    agentFactory: tools => new PiAgentAdapter({ cwd: paths.runtimeDir, agentDir: paths.runtimeDir, tools,
      credentials: new InMemoryCredentialStore(), runtimeApiKey: 'synthetic-research-key' }) }));
  deferCleanup(() => opened.close());
  return opened;
  };
  let app = await open();
  const session = researchNeed(await app.createSession({ title: 'Research fixture' }));
  const material = options.material ? researchNeed(await app.importResearchMaterial({ title: 'Deployment evidence.md', format: 'markdown', text: options.material })) : null;
  const task = researchNeed(await app.createResearchTask({ sessionId: session.sessionId, title: 'Deployment comparison',
    sourcePolicy: { ...researchPlan.sourcePolicy, web: options.web ?? false, artifactIds: material ? [material.artifactId] : [], documentIds: documentId ? [documentId] : [] } }));
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
  return { get app() { return app; }, task, session, config, paths, requests, reviewRequests, request, start, run,
    async reopen() { researchNeed(await app.close()); app = await open(); } };
}
