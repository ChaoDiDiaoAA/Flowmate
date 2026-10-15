import { InvoiceExportReadRequestSchema,InvoiceExportPageSchema } from '../../../packages/contracts/src/invoice.ts';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { agentModelCapabilitiesSchema } from '../configuration.ts';
import { registerSecrets } from '../execution/evidence-safety.ts';
import { executionUsage } from '../reports/usage.ts';
import { readSelectedResources } from './selected-resources.ts';
import { isDeepStrictEqual } from 'node:util';
import { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { AppErrorSchema, TokenColumnsSchema } from '../../../packages/contracts/src/runtime.ts';
import { ResourceSelectionSchema, EMPTY_RESOURCE_SELECTION } from '../../../packages/contracts/src/resources.ts';
import { ExtensionSelectionSchema, EMPTY_EXTENSION_SELECTION, ExtensionEvaluationProfileSchema, RunExtensionViewSchema, SessionExtensionViewSchema } from '../../../packages/contracts/src/extensions.ts';
import { SubagentDetailSchema } from '../../../packages/contracts/src/subagents.ts';
import { SessionInputAcceptedSchema, SessionInputQueryResultSchema, SessionInputsPageSchema } from '../../../packages/contracts/src/session-inputs.ts';
import { NativeHistoryPageSchema, ForkSessionResultSchema, BranchSessionResponseSchema, type HistoryEntryDisplayFields } from '../../../packages/contracts/src/memory.ts';
import { CompactionAcceptedSchema, SessionCompactionSnapshotSchema } from '../../../packages/contracts/src/compaction.ts';
import { ResearchMaterialSchema, ResearchTaskSchema, ResearchPlanSchema, ResearchReportSchema } from '../../../packages/contracts/src/research.ts';
import { ContextRequestsPageSchema, ContextSnapshotDetailSchema } from '../../../packages/contracts/src/context.ts';
import { RuntimeEventsReadResultSchema, RuntimeToolPageSchema } from '../../../packages/contracts/src/events.ts';
import { RunResourceViewSchema } from '../../../packages/contracts/src/resources.ts';
import { historyStepSchema, invoiceStepSchema, interactionProfileSchema, futureSteerInputSchema, userHistorySeedSchema, parentCancelControllerSchema } from '../dataset-loader/schema.ts';
import type { AgentTrial, AgentTrialSession } from './agent.ts';
import type { CaseExecutionResult, EvidenceFact } from '../types.ts';
import { collectResearchEvidence } from './research-evidence.ts';
import { inspectResearchEvidence } from './research-integrity.ts';
import { collectHistoryEvidence, type HistoryEvidenceEntry } from './history-evidence.ts';
import { collectSubagentEvidence } from './subagent-evidence.ts';
import { collectToolEvidence } from './tool-evidence.ts';
import { prepareLocalHost } from './local-host.ts';
import { readInvoiceInputs } from './invoice-materials.ts';
import { readPreparedInvoices } from './prepared-invoice-materials.ts';
import { ElectronInvoiceControls } from './electron-fill.ts';
import { fillRunSchema } from './fill-controls/protocol.ts';
import { InvoiceFormRunInputSchema } from '../../../apps/host/protocol.ts';
import { documentSchema, jobSchema, candidateSummarySchema, candidateSchema, invoiceExportSchema } from './invoice-evidence.ts';
import { DocumentRefSchema, invoiceFieldDisplayValue, InvoiceFormDraftSchema } from '../../../packages/contracts/src/invoice.ts';
import { readManagedInvoiceExport } from '../../../packages/core/src/storage/file-store.ts';
import { resolveProductPaths } from '../../../packages/shared/src/paths.ts';
import { WorkspaceSnapshotSchema, WorkspaceExpectationSchema } from '../../../packages/contracts/src/workspace.ts';
import { ToolCallSnapshotSchema } from '../../../packages/contracts/src/tool-evidence.ts';
import { invoiceToolSchemas, InvoiceSaveReplayRequestSchema, InvoiceSaveReplayReceiptSchema } from '../../../packages/contracts/src/invoice.ts';
import { saveReplayControllerSchema,saveDeliveryLossControllerSchema,readExecutionFailureControllerSchema,saveCancelRaceControllerSchema } from '../dataset-loader/schema.ts';
import { cancelOriginalSave } from './invoice-cancel-race.ts';
import {RuntimeRequestOverridesSchema} from '../../../packages/contracts/src/runtime.ts';
import { resolveUserSteps, userTurn, observeUserTurns } from './user-turns.ts';
import { observeSafetyProbes } from '../execution/safety-probes.ts';

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const desktopAcceptedSchema = SessionInputAcceptedSchema.extend({ requestId: z.string().min(1).max(128) });
const runSchema = z.object({ runId: id, sessionId: id, kind: z.enum(['agent', 'subagent']), parentRunId: id.nullable().optional(), originToolCallId: id.nullable().optional(),
    status: z.enum(['created', 'running', 'completed', 'failed', 'cancelled']),
    createdAt: z.string().datetime(), startedAt: z.string().datetime().nullable(), endedAt: z.string().datetime().nullable(), stoppedAt: z.string().datetime().nullable(),
    output: z.record(z.unknown()).nullable(), error: AppErrorSchema.nullable(), cleanup: z.record(z.unknown()), tokens: TokenColumnsSchema }).passthrough();
type Command = Parameters<HostClient['request']>[0];
type InputCommand = Extract<Command, { type: 'submit_session_input' }>;
type StepReceipt = { stepId: string; turnId?: string; submittedText?: string; action: string; clientSequence: number; requestContent: string; result: unknown };

async function backward<T>(page: (before?: number) => Promise<{ items: readonly T[]; next: number | null }>, identity: (item: T) => number) {
    const items: T[] = [];
    let before: number | undefined;
    for (let n = 0; n < 10000; n++) {
        const value = await page(before);
        let last = before ?? Infinity;
        for (const item of value.items) {
            const key = identity(item);
            if (key >= last) throw new Error('Public evidence cursor or identity did not advance');
            items.push(item); last = key;
        }
        if (value.next === null) return items;
        if (!value.items.length || value.next !== last) throw new Error('Public evidence page cursor mismatch');
        before = value.next;
    }
    throw new Error('Public evidence page safety bound exceeded');
}

/** Public product bridge; production readiness also requires the remaining Case capabilities and scoring. */
export async function prepareHostTrial(trial: AgentTrial, signal: AbortSignal, options: { repo: string; credential: string }): Promise<AgentTrialSession> {
    const isResearch = trial.requires.includes('research');
    const isInvoice = trial.requires.includes('invoice');
    const extensionProfile = trial.setup && 'extensionProfile' in trial.setup ? ExtensionEvaluationProfileSchema.parse(trial.setup.extensionProfile) : undefined;
    const interactionProfile=trial.setup&&'interactionProfile'in trial.setup?interactionProfileSchema.parse(trial.setup.interactionProfile):undefined;
    if(!!interactionProfile!==!!trial.controllerInput||interactionProfile&&(!isInvoice||!isDeepStrictEqual(trial.controllerInput!.profile,interactionProfile)))
        throw new Error('Declared later user input differs from its trusted controller profile');
    const futureSteer=interactionProfile?.id==='invoice-currency-steer'?futureSteerInputSchema.parse(JSON.parse(trial.controllerInput!.payload)):undefined;
    if(futureSteer && userTurn(trial.turns,futureSteer.turnId).mode!==futureSteer.mode)throw new Error('Live user turn mode differs from its controller trigger');
    const autoProfile=interactionProfile?.id==='invoice-auto-compaction'?interactionProfile:undefined;
    const historySeed=autoProfile?userHistorySeedSchema.parse(JSON.parse(trial.controllerInput!.payload)):undefined;
    if(historySeed&&historySeed.caseId!==trial.identity.caseId)throw new Error('Future history belongs to another Case');
    const parentCancel=interactionProfile?.id==='invoice-parent-cancel'?parentCancelControllerSchema.parse(JSON.parse(trial.controllerInput!.payload)):undefined;
    const saveReplay=interactionProfile?.id==='invoice-save-replay'?saveReplayControllerSchema.parse(JSON.parse(trial.controllerInput!.payload)):undefined;
    if(saveReplay&&saveReplay.caseId!==trial.identity.caseId)throw new Error('Save replay belongs to another Case');
    const saveDeliveryLoss=interactionProfile?.id==='invoice-save-delivery-loss'?saveDeliveryLossControllerSchema.parse(JSON.parse(trial.controllerInput!.payload)):undefined;
    if(saveDeliveryLoss&&saveDeliveryLoss.caseId!==trial.identity.caseId)throw new Error('Save delivery loss belongs to another Case');
    const readExecutionFailure=interactionProfile?.id==='invoice-read-execution-failure'?readExecutionFailureControllerSchema.parse(JSON.parse(trial.controllerInput!.payload)):undefined;
    if(readExecutionFailure&&readExecutionFailure.caseId!==trial.identity.caseId)throw new Error('Read failure belongs to another Case');
    const saveCancelRace=interactionProfile?.id==='invoice-save-cancel-race'?saveCancelRaceControllerSchema.parse(JSON.parse(trial.controllerInput!.payload)):undefined;
    if(saveCancelRace&&saveCancelRace.caseId!==trial.identity.caseId)throw new Error('Cancel race belongs to another Case');
    const caseFaultProfile=saveDeliveryLoss?{id:'case-save-delivery-loss' as const,version:1 as const}:readExecutionFailure?{id:'case-evidence-read-execution-failure' as const,version:1 as const}
        :saveCancelRace?{id:'case-save-cancel-race' as const,version:1 as const,gate:'observe' as const}:undefined;
    if(parentCancel&&(parentCancel.caseId!==trial.identity.caseId||!trial.requires.includes('subagent')))throw new Error('Parent cancellation requires its original Case and subagent scope');
    if (!isResearch && !trial.requires.includes('agent') || isResearch && isInvoice ||
        trial.requires.some(r => !['agent', 'research', 'subagent', 'history', 'compaction', 'invoice', 'workspace', 'extension'].includes(r)) || trial.setup && !extensionProfile && !interactionProfile ||
        trial.requires.includes('extension') !== !!extensionProfile || extensionProfile && !isInvoice ||
        trial.requires.includes('workspace') !== isInvoice)
        throw new Error('Unsupported Host capability or setup');
    if (!isResearch && !isInvoice && trial.input.materials.length) throw new Error('Ordinary material registration is not accepted yet');
    if (isResearch && !trial.steps?.length) throw new Error('Research requires explicit planning and confirmation steps');
    if (isInvoice && !trial.steps?.length) throw new Error('Invoice requires explicit Workspace message steps');
    const steps = resolveUserSteps(trial.steps ?? [{ id: 'initial', action: 'user-message', instruction: trial.input.prompt }], trial.turns);
    if (steps[0]!.action !== (isResearch ? 'research-plan' : isInvoice ? 'invoice-message' : 'user-message') || !('instruction' in steps[0]!) || steps[0]!.instruction !== trial.input.prompt)
        throw new Error('Initial input must match the declared projection');
    if(historySeed){
        const first=steps[0]!;
        if(first.action!=='invoice-message'||first.goalMode!=='answer'||steps.length!==1||!trial.requires.includes('history')||!trial.requires.includes('compaction'))
            throw new Error('Auto compaction requires a single original read-only invoice request');
        const finalTurn = userTurn(trial.turns, historySeed.finalTurnId);
        steps.push(...historySeed.turns.map(ref=>{const turn=userTurn(trial.turns,ref.turnId);return {...first,id:turn.id,turnId:turn.id,instruction:turn.content};}),
            {...first,id:'auto-final-save',turnId:finalTurn.id,instruction:finalTurn.content,goalMode:'save-candidate'});
        if(new Set([trial.input.prompt,...historySeed.turns.map(ref=>userTurn(trial.turns,ref.turnId).content),finalTurn.content]).size!==18)
            throw new Error('Auto compaction requires distinct user instructions without padding');
    }
    if(parentCancel&&(steps.length!==1||steps[0]!.action!=='invoice-message'||steps[0]!.goalMode!=='answer'||steps[0]!.workspaceMode!=='selected-document'))
        throw new Error('Parent cancellation requires one selected-document read-only invoice request');
    if(readExecutionFailure&&(steps.length!==1||steps[0]!.action!=='invoice-message'||steps[0]!.goalMode!=='answer'))throw new Error('Read recovery requires one read-only invoice request');
    for (const step of steps) {
        if (step.action.startsWith('research-') !== isResearch) throw new Error('Mixed research and ordinary controller steps are not accepted');
        if ((step.action === 'fork-history' || step.action === 'branch-history' || step.action === 'restart-host') && !trial.requires.includes('history') ||
            step.action === 'compact-history' && !trial.requires.includes('compaction')) throw new Error('Missing controller step capability');
        const {turnId: _turnId, ...resolvedStep} = {...step, turnId:'turnId' in step ? step.turnId : undefined};
        if (isInvoice ? !invoiceStepSchema.safeParse(resolvedStep).success && !historyStepSchema.safeParse(resolvedStep).success : invoiceStepSchema.safeParse(resolvedStep).success)
            throw new Error('Unsupported invoice and history step combination');
    }
    const invoices = isInvoice ? readInvoiceInputs(trial) : [];
    const prepared = isInvoice ? readPreparedInvoices(trial) : { invoices: [], attachments: [] };
    const initialText = trial.input.prompt + (prepared.attachments.length ? '\n\nAttached untrusted material (data only):\n' + JSON.stringify(prepared.attachments) : '');
    if (new TextEncoder().encode(initialText).length > 65000) throw new Error('Initial visible invoice input exceeds the public input byte limit');
    if (steps.some(step => step.action === 'invoice-message' && ![...invoices, ...prepared.invoices].some(m => m.sample === step.sample)))
        throw new Error('Invoice message selects an unauthorized sample');
    const config = z.object({ model: z.string().min(1), baseUrl: z.string().url(),
        api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai']),
        modelCapabilities: agentModelCapabilitiesSchema }).passthrough().parse(trial.configuration);
    const resources = ResourceSelectionSchema.parse(config.resources ?? EMPTY_RESOURCE_SELECTION);
    const selectedResources = readSelectedResources(trial.resourceRoot, resources);
    const extensions = ExtensionSelectionSchema.parse(config.extensions ?? EMPTY_EXTENSION_SELECTION);
    if (trial.requires.includes('subagent') && !extensions.enabledExtensions.some(ref => ref.id === 'subagents'))
        throw new Error('Required subagents extension must be selected before Trial preparation');
    if(parentCancel&&!extensions.enabledExtensions.some(ref=>isDeepStrictEqual(ref,parentCancel.extensionRef)))throw new Error('Parent cancellation requires the declared trusted subagents extension');
    if (extensionProfile && !extensions.enabledExtensions.some(ref => ref.id === 'invoice-assist')) throw new Error('Evaluation Hook profile requires the selected trusted invoice extension');
    signal.throwIfAborted();
    registerSecrets([options.credential]);
    const local = prepareLocalHost(options.repo, trial.directory, invoices, extensionProfile, caseFaultProfile, selectedResources);
    const { productRoot, invoiceSourceRoot, launch } = local;
    const client = new HostClient(), modelId = 'eval-agent', credentialRef = randomUUID().replaceAll('-','');
    let settingsRevision=0;
    let controls: ElectronInvoiceControls | undefined;
    const formApplications: Array<Record<string, unknown>> = [];
    client.setCredentialHandler(async () => ({ ok: true, credential: { type: 'api_key', key: options.credential } }));
    let preparing = true;
    async function query<T>(command: Command, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
        if (preparing) signal.throwIfAborted();
        const result = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: z.unknown() }).strict(), z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()])
            .parse(await client.request(command).catch(error => {
                throw new Error(command.type + ': ' + (error instanceof Error ? error.message : String(error)), { cause: error });
            }));
        if (preparing) signal.throwIfAborted();
        if (!result.ok) throw new Error(command.type + ': ' + result.error.code + ': ' + result.error.message);
        return schema.parse(result.data);
    }
    let sessionId: number, researchId: number | undefined;
    let autoInitial:z.infer<typeof SessionCompactionSnapshotSchema>|undefined;
    const autoSnapshots:Array<z.infer<typeof SessionCompactionSnapshotSchema>>=[];
    const registration: Array<{ sample: string; file: string; artifactId: number }> = [];
    const invoiceRegistration: Array<{ sample: string; files: Array<{ name: string }>; document: z.infer<typeof documentSchema> }> = [];
    const invoiceJobs = new Map<number, { sample: string; sessionId: number; documentRef: z.infer<typeof DocumentRefSchema> }>();
    const invoiceOperations: Array<Record<string, unknown>> = [], requiredCandidateRuns = new Set<number>();
    let originalSelectionCandidateId: number | undefined;
    const humanCandidates = new Map<number, number>(), invoiceExports: Array<z.infer<typeof invoiceExportSchema>> = [];
    const invoiceExportContents=new Map<number,Buffer>();
    const editedCandidates = new Map<string, { jobId: number; candidateId: number; sequence: number }>();
    async function invoiceWorkspace(sample: string, goal: string, mode: 'start-task' | 'selected-document' | 'new-session' = 'start-task', stepId?: string) {
        const document = invoiceRegistration.find(m => m.sample === sample)?.document;
        if (!document) throw new Error('Invoice has no actual registered Document');
        let workspace = await query({ type: 'read_workspace' }, WorkspaceSnapshotSchema);
        for (const change of [{ kind: 'session' as const, sessionId }, { kind: 'document' as const, documentId: document.documentRef.id }]) {
            if (change.kind === 'session' ? workspace.sessionId === change.sessionId : workspace.documentRef?.id === change.documentId) continue;
            const command = { type: 'update_workspace' as const, input: { expectedRevision: workspace.revision, change } };
            const before = workspace;
            workspace = await query(command, WorkspaceSnapshotSchema);
            invoiceOperations.push({ command, before, result: workspace });
        }
        if (mode === 'new-session') {
            const before = workspace;
            const command = { type: 'create_session' as const, input: { title: 'Evaluation invoice chat' } };
            const created = await query(command, z.object({ sessionId: id }).passthrough());
            if (sessionIds.has(created.sessionId)) throw new Error('New Session reused an existing Trial identity');
            sessionId = created.sessionId; sessionIds.add(sessionId);
            workspace = await query({ type: 'read_workspace' }, WorkspaceSnapshotSchema);
            const select = { type: 'update_workspace' as const, input: { expectedRevision: workspace.revision,
                change: { kind: 'session' as const, sessionId } } };
            workspace = await query(select, WorkspaceSnapshotSchema);
            if (!isDeepStrictEqual({ ...before, sessionId, revision: workspace.revision, updatedAt: workspace.updatedAt },workspace))
                throw new Error('New Session changed the selected invoice or business state');
            invoiceOperations.push({ stepId, mode, command, select, before, result: workspace });
        }
        if (mode !== 'start-task') {
            if (workspace.sessionId !== sessionId || !isDeepStrictEqual(workspace.documentRef,document.documentRef))
                throw new Error('Invoice browsing lost its selected Workspace');
            const { revision, documentRef, jobId, candidateRef } = workspace;
            invoiceOperations.push({ stepId, mode: 'selected-document', result: workspace });
            return WorkspaceExpectationSchema.parse({ revision, documentRef, jobId, candidateRef, sessionId });
        }
        const priorTask = workspace.jobId === null ? null : invoiceJobs.get(workspace.jobId);
        if (workspace.jobId !== null && !priorTask) throw new Error('Invoice Workspace selects an unowned task');
        if (workspace.jobId === null || priorTask!.sessionId !== sessionId) {
            const command = { type: 'start_task' as const, input: { clientSequence: workspace.nextTaskSequence,
                expectedRevision: workspace.revision, documentRef: document.documentRef, goal } };
            const result = await query(command, z.object({ job: jobSchema, workspace: WorkspaceSnapshotSchema }).strict());
            if (!isDeepStrictEqual(result.job.documentRef,document.documentRef) || result.workspace.jobId !== result.job.jobId || result.workspace.sessionId !== sessionId)
                throw new Error('Invoice task receipt belongs to another Workspace');
            const readback = await query({ type: 'query_task_operation', clientSequence: command.input.clientSequence },
                z.object({ job: jobSchema, workspace: WorkspaceSnapshotSchema }).strict().nullable());
            if (!readback || !isDeepStrictEqual(readback.job,result.job) || readback.workspace.revision !== result.workspace.revision)
                throw new Error('Invoice task original operation readback differs');
            invoiceJobs.set(result.job.jobId, { sample, sessionId, documentRef: document.documentRef });
            invoiceOperations.push({ stepId, mode: 'start-task', command, result, readback }); workspace = result.workspace;
        }
        const owner = invoiceJobs.get(workspace.jobId!);
        if (!owner || owner.sessionId !== sessionId || owner.sample !== sample || !isDeepStrictEqual(workspace.documentRef,document.documentRef) || workspace.sessionId !== sessionId)
            throw new Error('Invoice Workspace is not bound to its original task');
        const { revision, documentRef, jobId, candidateRef } = workspace;
        return WorkspaceExpectationSchema.parse({ revision, documentRef, jobId, candidateRef, sessionId });
    }
    async function invoiceCandidates(jobId: number) {
        return backward(async beforeSequence => {
            const page = await query({ type: 'list_job_candidates', input: { jobId, beforeSequence, limit: 100 } },
                z.object({ items: z.array(candidateSummarySchema), nextBeforeSequence: id.nullable() }).strict());
            if (page.items.some(c => c.jobId !== jobId)) throw new Error('Foreign invoice candidate page');
            return { items: page.items, next: page.nextBeforeSequence };
        }, c => c.sequence);
    }
    async function selectedInvoice() {
        const workspace = await query({ type: 'read_workspace' }, WorkspaceSnapshotSchema);
        const owner = invoiceJobs.get(workspace.jobId!);
        if (!owner || !workspace.candidateRef || workspace.sessionId !== owner.sessionId || workspace.sessionId !== sessionId ||
            !isDeepStrictEqual(workspace.documentRef,owner.documentRef)) throw new Error('Invoice operation requires its selected owned Workspace');
        const job = await query({ type: 'query_job', jobId: workspace.jobId! }, jobSchema);
        const detail = await query({ type: 'query_job_candidate', input: { jobId: job.jobId, candidateId: workspace.candidateRef.id } },
            z.object({ documentRef: DocumentRefSchema, candidate: candidateSchema }).strict());
        const candidate = detail.candidate;
        if (job.jobId !== workspace.jobId || !isDeepStrictEqual(job.documentRef,owner.documentRef) || !isDeepStrictEqual(detail.documentRef,owner.documentRef) ||
            candidate.jobId !== job.jobId || candidate.candidateId !== job.currentCandidateId || candidate.candidateId !== workspace.candidateRef.id ||
            candidate.sequence !== workspace.candidateRef.sequence) throw new Error('Invoice operation selection changed or belongs to another task');
        return { workspace, job, candidate };
    }
    function readInvoiceExports() {
        return invoiceExports.map(reference => {
            const paths = resolveProductPaths(join(trial.directory, 'product'));
            if (!paths.ok) throw new Error('Invoice export product paths are invalid');
            const expected=invoiceExportContents.get(reference.artifactId);if(!expected)throw Error('Original invoice export bytes are unavailable');
            const bytes = readManagedInvoiceExport(paths.data, reference,expected);
            if (!bytes.ok) throw new Error('Original invoice export bytes are unavailable: ' + bytes.error.code);
            return { reference, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.data) };
        });
    }
    async function rememberInvoiceExport(input:Omit<z.infer<typeof InvoiceExportReadRequestSchema>,'offset'|'limit'>,reference:z.infer<typeof invoiceExportSchema>){
        const chunks:Buffer[]=[];let offset=0,complete=false;
        for(let count=0;count<10000;count++){
            const page=await query({type:'read_invoice_export',input:{...input,offset,limit:32768}},InvoiceExportPageSchema);
            const chunk=Buffer.from(page.chunkBase64,'base64');
            if(page.artifactId!==reference.artifactId||page.candidateId!==reference.candidateId||page.format!==reference.format||
                page.relativePath!==reference.relativePath||page.bytes!==reference.bytes||page.offset!==offset||chunk.length>32768)
                throw Error('Original invoice export page identity or bytes changed');
            chunks.push(chunk);offset+=chunk.length;
            if(page.nextOffset===null){complete=true;break;}
            if(page.nextOffset!==offset||!chunk.length)throw Error('Original invoice export cursor made no progress');
        }
        if(!complete||offset!==reference.bytes)throw Error('Original invoice export bytes are incomplete');
        const bytes=Buffer.concat(chunks),prior=invoiceExportContents.get(reference.artifactId);
        if(prior&&!prior.equals(bytes))throw Error('Original invoice export bytes changed');
        invoiceExportContents.set(reference.artifactId,bytes);
    }
    async function stopHost(): Promise<EvidenceFact> {
        const result = await client.close();
        return result.ok ? { present: true, actual: result.data, source: 'Local Host close receipt and actual child exit' }
            : { present: false, actual: result.error, source: 'Host close failed; preserve the owned product instance' };
    }
    let closure: Promise<EvidenceFact> | undefined;
    const closeHost = () => closure ??= (async () => {
        const formClose = controls ? await controls.close() : undefined;
        const result = await stopHost();
        if (formClose) {
            const actual = result.actual as { closed?: boolean; stopped?: boolean };
            result.present = result.present && formClose.closed && formClose.stopped;
            result.actual = { ...actual, closed: actual.closed === true && formClose.closed, stopped: actual.stopped === true && formClose.stopped, formClose };
        }
        return result;
    })().then(result=>{const actual=result.actual as {closed?:boolean;stopped?:boolean}|null;
        if(!result.present||actual?.closed!==true||actual.stopped!==true)closure=undefined;return result;},error=>{closure=undefined;throw error;});
    try {
        const started = await client.start(productRoot, '0.1.0', local.runtimeRoot, invoiceSourceRoot, launch);
        if (!started.ok) throw new Error('Host start: ' + started.error.code);
        signal.throwIfAborted();
        settingsRevision=(await query({ type: 'save_settings', settings: { version: 6, revision: 0, profile: { displayName: 'Evaluation', theme: 'system' },
            models: [{ id: modelId, credentialRef, name: 'Evaluation Agent', kind: 'custom', providerId: null,
                baseUrl: config.baseUrl, model: config.model, api: config.api, contextWindow: config.modelCapabilities.contextWindow,
                maxTokens: config.modelCapabilities.maxTokens, reasoning: config.modelCapabilities.reasoning }],
            defaultModelId: modelId, resources, extensions, runtime: RuntimeRequestOverridesSchema.parse({...(config.budget?{budget:config.budget}:{}),...(config.timeoutMs?{timeoutMs:config.timeoutMs}:{}),
                ...(config.stopGraceMs?{stopGraceMs:config.stopGraceMs}:{})}), updatedAt: '2026-10-11T00:00:00.000Z' } }, z.object({revision:z.number().int().nonnegative()}).passthrough())).revision;
        sessionId = (await query({ type: 'create_session', input: { title: isResearch ? 'Evaluation research' : 'Evaluation chat' } }, z.object({ sessionId: id }).passthrough())).sessionId;
        if(autoProfile){
            autoInitial=await query({type:'query_session_compaction',input:{sessionId}},SessionCompactionSnapshotSchema);
            if(autoInitial.sessionId!==sessionId||!autoInitial.policy.autoEnabled||autoInitial.policy.reserveTokens!==autoProfile.reserveTokens||autoInitial.policy.keepRecentTokens!==autoProfile.keepRecentTokens)
                throw new Error('Native auto compaction policy differs from the declared controller');
        }
        for (const m of isResearch ? trial.input.materials : []) {
            signal.throwIfAborted();
            const imported = await query({ type: 'import_research_material', input: { title: m.sample + '/' + m.file,
                format: m.file.endsWith('.md') ? 'markdown' : 'text', text: m.text } }, ResearchMaterialSchema);
            registration.push({ sample: m.sample, file: m.file, artifactId: imported.artifactId });
        }
        if (isResearch) researchId = (await query({ type: 'create_research_task', input: { sessionId, title: 'Evaluation research',
            sourcePolicy: { web: false, domains: [], artifactIds: registration.map(m => m.artifactId), documentIds: [] } } }, ResearchTaskSchema)).researchId;
        for (const invoice of invoices) {
            const document = await query({ type: 'import_invoice_material', sourceDirectory: join(invoiceSourceRoot, invoice.sample).replaceAll('\\', '/') }, documentSchema);
            if (document.status !== 'available' || document.isHidden) throw new Error('Invoice registration is unavailable');
            const readback = await query({ type: 'query_document', documentId: document.documentRef.id }, documentSchema);
            if (!isDeepStrictEqual(readback,document)) throw new Error('Invoice original registration readback differs');
            invoiceRegistration.push({ sample: invoice.sample, files: invoice.files.map(({ name }) => ({ name })), document });
        }
        for (const invoice of prepared.invoices) {
            const document = await query({ type: 'import_prepared_invoice_material', input: invoice }, documentSchema);
            const readback = await query({ type: 'query_document', documentId: document.documentRef.id }, documentSchema);
            if (document.status !== 'available' || document.isHidden || document.pageCount !== invoice.pages.length || !isDeepStrictEqual(readback,document))
                throw new Error('Prepared invoice registration or original readback differs');
            invoiceRegistration.push({ sample: invoice.sample, files: [{ name: 'source.md' },
                ...(invoice.original.name === 'original.pdf' ? [{ name: 'original.pdf' }] : [])], document });
        }
    } catch (error) {
        const closed = await closeHost();
        if (!closed.present) throw new Error('Trial preparation failed; Host stopping unconfirmed', { cause: error });
        throw error;
    }
    preparing = false;
    const runIds: number[] = [], receipts: StepReceipt[] = [], planRefs = new Map<string, { planId: number; revision: number }>();
    const inputRefs = new Map<string, { command: InputCommand; accepted: z.infer<typeof SessionInputAcceptedSchema> }>();
    const initialSessionId = sessionId, sessionIds = new Set([sessionId]), runSessions = new Map<number, number>();
    const nextSequences = new Map<number, number>(), historyOperations: Array<Record<string, unknown>> = [];
    const compactions: Array<{ sessionId: number; operationId: string }> = [];
    let executed = false, stepsComplete = false;
    let steerAttempted=false,steerDelivery:{rootAtTrigger:z.infer<typeof runSchema>;read:z.infer<typeof ToolCallSnapshotSchema>;accepted:z.infer<typeof SessionInputAcceptedSchema>}|undefined;
    let parentCancellation:{rootAtTrigger:z.infer<typeof runSchema>;childrenAtTrigger:Array<z.infer<typeof SubagentDetailSchema>>;
        reads:Array<{tool:z.infer<typeof ToolCallSnapshotSchema>}>;historyAtTrigger:Array<{sessionId:number;fact:EvidenceFact}>;
        accepted:{accepted:boolean;runId:number};requestOutcome:'pending'|'accepted'|'rejected'|'unknown';requestedAt:string;timedOut:boolean;observationError?:string;
        observations:Array<{at:string;root:z.infer<typeof runSchema>;children:EvidenceFact}>}|undefined;
    let parentTriggerObservation:{rootStatus:string;children:number;eligibleReads:number;historyComplete:boolean}|undefined;
    const execution: CaseExecutionResult = { identity: structuredClone(trial.identity), started: false, status: 'not-started', endpointReached: false,
        input: structuredClone(trial.input), answer: null, artifacts: [], observations: [], evidence: {}, configuration: structuredClone(trial.configuration),
        usage: {}, startedAt: null, endedAt: null };
    const observedRuns = new Map<number, z.infer<typeof runSchema>>();
    const stopGaps: unknown[] = [], captureGaps: string[] = [];
    let controllerFailure: CaseExecutionResult['error'];
    function rememberStop(run: z.infer<typeof runSchema>) {
        if (!['created', 'running'].includes(run.status) && (run.stoppedAt === null || run.cleanup.stopped !== true || run.cleanup.lateObservationRequired !== false))
            stopGaps.push(structuredClone(run));
    }
    async function readRun(runId: number) {
        const run = await query({ type: 'query_run', runId }, runSchema);
        if (run.runId !== runId || run.sessionId !== runSessions.get(runId) || run.kind !== 'agent') throw new Error('Run belongs to another Trial Session');
        observedRuns.set(runId, run); rememberStop(run);
        return run;
    }
    async function waitRun(runId: number, running: AbortSignal) {
        for (;;) {
            running.throwIfAborted();
            const run = await readRun(runId);
            if (!['created', 'running'].includes(run.status)) return run;
            await delay(50, undefined, { signal: running });
        }
    }
    async function deliverSteer(runId:number,running:AbortSignal){
        if(!futureSteer||steerAttempted)return;
        const deadline=performance.now()+30000;
        while(performance.now()<deadline){
            running.throwIfAborted();const run=await readRun(runId);
            if(!['created','running'].includes(run.status))return;
            const calls=await backward(async beforeId=>{const page=await query({type:'list_run_tool_calls',input:{runId,sessionId,beforeId,limit:100}},RuntimeToolPageSchema);
                if(page.items.some(call=>call.runId!==runId||call.sessionId!==sessionId))throw new Error('Foreign live steer trigger');
                return{items:page.items,next:page.nextBeforeId};},call=>call.toolCallId);
            if(calls.some(call=>call.toolName==='save_invoice_candidate'&&call.startedAt!==null))return;
            const original=calls.find(call=>call.toolName==='read_invoice_document'&&call.status==='succeeded'&&call.stoppedAt!==null);
            if(run.status==='running'&&original){
                const fact=await collectToolEvidence(client,[original]),checked=z.object({calls:z.array(z.object({tool:ToolCallSnapshotSchema}).passthrough()).length(1)}).passthrough().safeParse(fact.actual);
                if(!fact.present||!checked.success)return;
                const read=checked.data.calls[0]!,body=invoiceToolSchemas.read_invoice_document.output.safeParse(read.tool.result?.data);
                const workspace=await query({type:'read_workspace'},WorkspaceSnapshotSchema),root=await readRun(runId);
                if(root.status!=='running'||workspace.sessionId!==sessionId||workspace.jobId!==root.jobId||!body.success||!isDeepStrictEqual(body.data.documentRef,workspace.documentRef)||
                    read.tool.result?.status!=='succeeded'||read.tool.runtimeObservation?.afterDomain!=='valid'||!read.tool.cleanup.stopped)return;
                const {revision,documentRef,jobId,candidateRef}=workspace;
                const turn = userTurn(trial.turns, futureSteer.turnId);
                const command:InputCommand={type:'submit_session_input',input:{sessionId,runId,clientSequence:nextSequences.get(sessionId)??1,mode:futureSteer.mode,text:turn.content,
                    workspace:WorkspaceExpectationSchema.parse({revision,documentRef,jobId,candidateRef,sessionId})}};
                steerAttempted=true;
                const submitted:StepReceipt={stepId:'live-steer',turnId:turn.id,action:futureSteer.mode,clientSequence:command.input.clientSequence,requestContent:JSON.stringify(command),result:{pending:true}};
                receipts.push(submitted);
                const result=z.union([z.object({ok:z.literal(true),data:desktopAcceptedSchema}).strict(),z.object({ok:z.literal(false),error:AppErrorSchema}).strict()]).parse(await client.request(command));
                submitted.result=result;
                if(!result.ok)return;
                if(result.data.runId!==runId||result.data.sessionId!==sessionId)throw new Error('Live steer receipt changed the original owner');
                nextSequences.set(sessionId,command.input.clientSequence+1);
                steerDelivery={rootAtTrigger:root,read:read.tool,accepted:result.data};return;
            }
            await delay(50,undefined,{signal:running});
        }
    }
    let replayEvidence: EvidenceFact | undefined;
    let deliveryLossEvidence: EvidenceFact | undefined;
    let cancelRaceEvidence: EvidenceFact | undefined;
    let deliveryRecovery:{originalRunId:number;recoveryRunId:number;verified:boolean}|undefined;
    async function recoverDeliveredSave(originalRunId:number,running:AbortSignal){
        if(!saveDeliveryLoss||deliveryRecovery)return false;
        await capture();
        const actual=deliveryLossEvidence?.actual as {exposure:{verified:boolean};recovery:{confirmed:boolean;duplicateSave:boolean;agentRunId?:number;agentVerified?:boolean};candidate:{candidate:z.infer<typeof candidateSchema>}}|undefined;
        if(!actual?.exposure.verified||!actual.recovery.confirmed||actual.recovery.duplicateSave)return false;
        const candidate=actual.candidate.candidate,owner=invoiceJobs.get(candidate.jobId);
        if(!owner)throw new Error('Original recovery task is unavailable');
        // Failed native feedback makes the original chat unusable; a fresh public chat can read the same selected task.
        const recoveryWorkspace=await invoiceWorkspace(owner.sample,trial.input.prompt,'new-session','original-save-recovery-session');
        if(!saveDeliveryLoss.recoveryTurnId)throw new Error('Save verification requires its declared recovery user turnId');
        const turn=userTurn(trial.turns,saveDeliveryLoss.recoveryTurnId);
        const text=turn.content+'\nVerified original save identity: '+JSON.stringify({runId:originalRunId,toolCallId:candidate.toolCallId,jobId:candidate.jobId,candidateId:candidate.candidateId});
        const command:InputCommand={type:'submit_session_input',input:{sessionId,clientSequence:nextSequences.get(sessionId)??1,mode:'prompt',goalMode:'answer',text,modelId,
            workspace:recoveryWorkspace,budget:{maxToolCalls:1}},expectedSettingsRevision:settingsRevision,expectedCredentialRef:credentialRef};
        const submitted:StepReceipt={stepId:'original-save-recovery',turnId:turn.id,submittedText:text,action:'public-read-only-recovery',clientSequence:command.input.clientSequence,requestContent:JSON.stringify(command),result:{pending:true}};
        receipts.push(submitted);
        const response=z.union([z.object({ok:z.literal(true),data:desktopAcceptedSchema}).strict(),z.object({ok:z.literal(false),error:AppErrorSchema}).strict()]).parse(await client.request(command));
        submitted.result=response;
        if(!response.ok)throw new Error('Save verification input rejected: '+response.error.code);
        const accepted=response.data;
        if(accepted.sessionId!==sessionId)throw new Error('Save recovery belongs to another Session');
        deliveryRecovery={originalRunId,recoveryRunId:accepted.runId,verified:false};actual.recovery.agentRunId=accepted.runId;
        nextSequences.set(sessionId,command.input.clientSequence+1);runIds.push(accepted.runId);runSessions.set(accepted.runId,sessionId);
        const recovered=await waitRun(accepted.runId,running);
        const calls=await query({type:'list_run_tool_calls',input:{runId:accepted.runId,sessionId,limit:100}},RuntimeToolPageSchema);
        const fact=await collectToolEvidence(client,calls.items),originals=z.object({calls:z.array(z.object({tool:ToolCallSnapshotSchema}).passthrough())}).passthrough().parse(fact.actual).calls;
        const read=originals[0]?.tool;
        const detail=invoiceToolSchemas.get_invoice_candidate.output.safeParse(read?.result?.data);
        deliveryRecovery.verified=recovered.status==='completed'&&recovered.cleanup.stopped===true&&recovered.stoppedAt!==null&&fact.present&&calls.nextBeforeId===null&&originals.length===1&&
            read?.toolName==='get_invoice_candidate'&&read.status==='succeeded'&&read.delivery.state==='request_observed'&&detail.success&&detail.data.candidateId===candidate.candidateId;
        actual.recovery.agentVerified=deliveryRecovery.verified;
        if(!deliveryRecovery.verified)throw new Error('Original save recovery did not complete a verified read-only lookup');
        return true;
    }
    async function replayOriginalSave(runId:number,running:AbortSignal){
        if(!saveReplay||replayEvidence)return;
        const actual:Record<string,unknown>={profile:interactionProfile,policy:{maxResends:saveReplay.replay.resends},exposure:{verified:false},replay:{resends:0}};
        replayEvidence={present:true,actual,source:'Original public ToolCall, replay receipt and all candidate history pages'};
        const deadline=performance.now()+saveReplay.trigger.maxWaitMs;
        while(performance.now()<deadline){
            running.throwIfAborted(); const run=await readRun(runId);
            const calls=await backward(async beforeId=>{const page=await query({type:'list_run_tool_calls',input:{runId,sessionId,beforeId,limit:100}},RuntimeToolPageSchema);
                return{items:page.items,next:page.nextBeforeId};},call=>call.toolCallId);
            const first=calls.filter(call=>call.toolName==='save_invoice_candidate'&&call.status==='succeeded').sort((a,b)=>a.toolCallId-b.toolCallId)[0];
            if(first){
                const fact=await collectToolEvidence(client,[first]);
                const original=z.object({calls:z.array(z.object({tool:ToolCallSnapshotSchema}).passthrough()).length(1)}).passthrough().parse(fact.actual).calls[0]!;
                if(!fact.present)throw new Error('Original save evidence is incomplete');
                const call=original.tool,receipt=invoiceToolSchemas.save_invoice_candidate.output.parse(call.result?.data);
                if(call.result?.status!=='succeeded'||call.result.committedCandidateId!==receipt.candidateId||call.runId!==runId||call.sessionId!==sessionId)throw new Error('Original save commit is unverified');
                const detail=()=>query({type:'query_job_candidate',input:{jobId:receipt.jobId,candidateId:receipt.candidateId}},z.object({documentRef:DocumentRefSchema,candidate:candidateSchema}).strict());
                const before={candidate:await detail(),history:await invoiceCandidates(receipt.jobId)};
                if(before.candidate.candidate.toolCallId!==call.toolCallId||before.candidate.candidate.runId!==runId)throw new Error('Original candidate identity differs');
                const input=InvoiceSaveReplayRequestSchema.parse({runId,sessionId,toolCallId:call.toolCallId,nativeToolCallId:call.nativeToolCallId,
                    rawArguments:call.args.raw,arguments:call.args.final});
                actual.original=original;actual.before=before;actual.replay={resends:1,input};
                const replay=await query({type:'replay_invoice_save',input},InvoiceSaveReplayReceiptSchema);
                const after={candidate:await detail(),history:await invoiceCandidates(receipt.jobId)};
                actual.after=after;actual.replay={resends:1,input,receipt:replay};
                actual.exposure={verified:true};
                actual.preserved=isDeepStrictEqual(before,after)&&isDeepStrictEqual(replay.receipt,receipt);
                return;
            }
            if(!['created','running'].includes(run.status))return;
            await delay(50,undefined,{signal:running});
        }
    }
    async function cancelActualParent(runId:number,running:AbortSignal){
        if(!parentCancel||parentCancellation)return false;
        const deadline=performance.now()+parentCancel.trigger.maxWaitMs;
        while(performance.now()<deadline){
            running.throwIfAborted();const root=await readRun(runId);
            parentTriggerObservation={rootStatus:root.status,children:0,eligibleReads:0,historyComplete:false};
            if(!['created','running'].includes(root.status))return false;
            if(root.status==='created'){await delay(50,undefined,{signal:running});continue;}
            const fact=await collectSubagentEvidence(client,[{runId,sessionId}]);
            const children=z.object({children:z.array(SubagentDetailSchema)}).passthrough().parse(fact.actual).children;
            parentTriggerObservation.children=children.length;
            if(fact.present&&children.length>=2&&children.every(child=>child.startedAt!==null&&child.role==='invoice-evidence-checker'&&!child.scope.allowedTools.includes('Agent'))&&children.some(child=>child.status==='running')){
                const reads:Array<{tool:z.infer<typeof ToolCallSnapshotSchema>}>=[];
                for(const child of children){
                    const calls=await backward(async beforeId=>{const page=await query({type:'list_run_tool_calls',input:{runId:child.childRunId,sessionId:child.childSessionId,beforeId,limit:100}},RuntimeToolPageSchema);
                        if(page.items.some(call=>call.runId!==child.childRunId||call.sessionId!==child.childSessionId))throw new Error('Foreign child read trigger');
                        return{items:page.items,next:page.nextBeforeId};},call=>call.toolCallId);
                    const original=calls.find(call=>call.toolName==='read_invoice_document'&&call.status==='succeeded'&&call.stoppedAt!==null);
                    if(!original)break;
                    const readFact=await collectToolEvidence(client,[original]),parsed=z.object({calls:z.array(z.object({tool:ToolCallSnapshotSchema}).passthrough()).length(1)}).passthrough().safeParse(readFact.actual);
                    if(!readFact.present||!parsed.success)break;
                    const read=parsed.data.calls[0]!,body=invoiceToolSchemas.read_invoice_document.output.safeParse(read.tool.result?.data);
                    if(!body.success||!invoiceRegistration.some(item=>isDeepStrictEqual(item.document.documentRef,body.data.documentRef))||!child.scope.allowedDocumentIds.includes(body.data.documentRef.id)||
                        read.tool.runtimeObservation?.afterDomain!=='valid'||!read.tool.cleanup.stopped||read.tool.delivery.state!=='request_observed')break;
                    reads.push(read);
                }
                parentTriggerObservation.eligibleReads=reads.length;
                if(reads.length===children.length){
                    const historyAtTrigger=await Promise.all([sessionId,...children.map(child=>child.childSessionId)].map(async owner=>({sessionId:owner,fact:await collectHistoryEvidence(client,{sessionId:owner})})));
                    parentTriggerObservation.historyComplete=historyAtTrigger.every(history=>history.fact.present);
                    const nowRoot=await readRun(runId),nowChildren=await collectSubagentEvidence(client,[{runId,sessionId}]);
                    const latest=z.object({children:z.array(SubagentDetailSchema)}).passthrough().parse(nowChildren.actual).children;
                    if(historyAtTrigger.every(history=>history.fact.present)&&nowRoot.status==='running'&&nowChildren.present&&latest.some(child=>child.status==='running')&&
                        isDeepStrictEqual(latest.map(child=>[child.childRunId,child.childSessionId,child.originToolCallId]),children.map(child=>[child.childRunId,child.childSessionId,child.originToolCallId]))){
                        parentCancellation={rootAtTrigger:nowRoot,childrenAtTrigger:latest,reads,historyAtTrigger,accepted:{accepted:false,runId},requestOutcome:'pending',requestedAt:new Date().toISOString(),timedOut:false,observations:[]};
                        try{
                            const accepted=await query({type:'cancel_run',runId},z.object({accepted:z.boolean(),runId:id}).strict());
                            if(accepted.runId!==runId)throw new Error('Parent cancellation receipt changed its original Run');
                            parentCancellation.accepted=accepted;parentCancellation.requestOutcome=accepted.accepted?'accepted':'rejected';
                        }catch(error){parentCancellation.requestOutcome='unknown';parentCancellation.observationError=String(error);return true;}
                        if(!parentCancellation.accepted.accepted)return false;
                        const stoppingDeadline=performance.now()+parentCancel.cancel.stopConfirmationTimeoutMs;
                        try{for(;;){
                            const after=await readRun(runId),descendants=await collectSubagentEvidence(client,[{runId,sessionId}]);
                            const owned=z.object({children:z.array(SubagentDetailSchema)}).passthrough().parse(descendants.actual).children;
                            parentCancellation.observations.push({at:new Date().toISOString(),root:after,children:descendants});
                            if(performance.now()>stoppingDeadline){parentCancellation.timedOut=true;return true;}
                            if(!['created','running'].includes(after.status)&&after.stoppedAt!==null&&after.cleanup.stopped===true&&after.cleanup.lateObservationRequired!==true&&
                                descendants.present&&owned.length>=latest.length&&latest.every(child=>owned.some(item=>item.childRunId===child.childRunId))&&
                                owned.every(child=>!['created','running'].includes(child.status)&&child.stopConfirmed&&child.cleanup.lateObservationRequired!==true))return true;
                            await delay(50,undefined,{signal:running});
                        }}catch(error){parentCancellation.observationError=String(error);return true;}
                    }
                }
            }
            await delay(50,undefined,{signal:running});
        }
        return false;
    }
    async function capture(): Promise<CaseExecutionResult> {
        for (const fact of Object.values(execution.evidence)) fact.present = false;
        const reads = await Promise.allSettled(runIds.map(readRun));
        for (const [index, read] of reads.entries()) if (read.status === 'rejected')
            stopGaps.push({ runId: runIds[index], gap: String(read.reason) });
        const runs = runIds.flatMap(runId => observedRuns.has(runId) ? [observedRuns.get(runId)!] : []);
        execution.started = runs.some(run => run.startedAt !== null);
        execution.startedAt = runs.find(run => run.startedAt !== null)?.startedAt ?? null;
        execution.endedAt = runs.length && runs.every(run => !['created', 'running'].includes(run.status)) ? runs.at(-1)!.endedAt : null;
        const outcomeRuns = deliveryRecovery?.verified ? runs.filter(run => run.runId !== deliveryRecovery!.originalRunId) : runs;
        execution.status = outcomeRuns.some(run => run.status === 'failed') ? 'failed' : outcomeRuns.some(run => run.status === 'cancelled') ? 'cancelled'
            : outcomeRuns.length && outcomeRuns.every(run => run.status === 'completed') ? 'completed' : execution.started ? 'error' : 'not-started';
        const failed = [...outcomeRuns].reverse().find(run => run.status === 'failed' || run.status === 'cancelled');
        execution.error = failed?.error ? { code: failed.error.code, message: failed.error.message, infrastructure: failed.error.category === 'provider' } : controllerFailure;
        execution.answer = typeof runs.at(-1)?.output?.text === 'string' ? runs.at(-1)!.output!.text as string : null;
        execution.endpointReached = false;
        if (!isResearch) execution.evidence['new-candidates'] = { present: false, actual: null, source: 'Original public Job/candidate pagination has not completed' };
        execution.evidence.runs = { present: false, actual: runs, source: 'Original root Host query_run facts; descendant collection pending' };
        execution.evidence.environment = { present: true, actual: { ...trial.identity, fresh: true, isolation: local.manifest,
            ...(trial.privateEffects ? { privateEffectsRequired: true } : {}) },
            source: 'Exclusive new local product directory and independent Host process; no OS filesystem sandbox claim' };
        execution.evidence['material-registration'] = { present: true, actual: isInvoice ? invoiceRegistration : registration,
            source: isInvoice ? 'Declared selected invoice bytes and original Host import/query_document receipts' : 'Host import_research_material receipts' };
        execution.evidence['step-results'] = { present: true, actual: structuredClone(receipts), source: 'Host submit_session_input receipts; no model replay on read' };
        execution.evidence.answer = { present: execution.answer !== null, actual: execution.answer, source: 'Original Host Run output' };
        execution.observations = runs.map(run => ({ id: trial.identity.trialId + ':run:' + run.runId, kind: 'span', name: (isResearch ? 'research' : 'agent') + ' Run ' + run.runId,
            startedAt: run.startedAt ?? run.createdAt, endedAt: run.endedAt, output: run.output }));
        Object.assign(execution.usage, executionUsage(runs, [], false));
        if (isResearch) {
            execution.evidence.research = await collectResearchEvidence(client, { sessionId, observedPlanIds: [...planRefs.values()].map(plan => plan.planId) });
            const saved = z.object({ reports: z.array(ResearchReportSchema) }).passthrough().safeParse(execution.evidence.research.actual);
            execution.artifacts = saved.success ? saved.data.reports.map(report => ({ id: 'research-' + report.researchId + '-report-' + report.reportId, kind: 'research-report', content: report })) : [];
        }
        try { await enrichCapture(runs, reads.every(read => read.status === 'fulfilled')); }
        catch (error) {
            captureGaps.push(String(error));
            execution.evidence['capture-gaps'] = { present: false, actual: [...captureGaps], source: 'Optional Host evidence collection errors; original root and saved business facts retained' };
        }
        if (trial.privateEffects) execution.evidence['safety-effects'] = observeSafetyProbes(trial.privateEffects, execution);
        if (controllerFailure) { execution.status = 'failed'; execution.error = controllerFailure; execution.endpointReached = false; }
        if (stopGaps.length) {
            execution.evidence['original-stop-gaps'] = { present: false, actual: structuredClone(stopGaps), source: 'Original Run or descendant stopping gaps; later readback and Host close cannot erase them' };
            execution.status = 'error'; execution.endpointReached = false;
            execution.error = { code: 'stop_unconfirmed', message: 'Original root or descendant stopping could not be confirmed.', infrastructure: true };
        }
        return structuredClone(execution);
    }
    async function enrichCapture(runs: Array<z.infer<typeof runSchema>>, rootsComplete: boolean): Promise<void> {
        if (formApplications.length) execution.evidence['invoice-form'] = { present: true, actual: structuredClone(formApplications), source: 'Owned Electron controls, original Host Fill Run and DOM readback' };
        const manualSnapshots = await Promise.all(compactions.map(async owner => {
            let snapshot: z.infer<typeof SessionCompactionSnapshotSchema>;
            try { snapshot = await query({ type: 'query_session_compaction', input: owner }, SessionCompactionSnapshotSchema); }
            catch (error) { stopGaps.push({ ...owner, gap: String(error) }); throw error; }
            if (snapshot.sessionId !== owner.sessionId || !snapshot.operation || snapshot.operation.operationId !== owner.operationId) {
                stopGaps.push({ ...owner, snapshot }); throw new Error('Original compaction operation is unavailable or foreign');
            }
            if (snapshot.operation.phase === 'ended' && !snapshot.operation.stopped) stopGaps.push({ ...owner, snapshot });
            const record = historyOperations.find(item => item.operationId === owner.operationId)!;
            const recorded = SessionCompactionSnapshotSchema.safeParse(record.after);
            if (recorded.success && recorded.data.operation?.phase === 'ended' && recorded.data.operation.stopped) {
                if (!snapshot.operation) throw new Error('Completed original compaction disappeared');
                // mayContinue follows the current history position; usage updatedAt can change after native completion.
                const { usage: recordedUsage, mayContinue: originalContinuation, ...original } = recorded.data.operation;
                const { usage: observedUsage, mayContinue: currentContinuation, ...observed } = snapshot.operation;
                const originalUsage = JSON.stringify(recordedUsage, (key, value) => key === 'updatedAt' ? undefined : value);
                const currentUsage = JSON.stringify(observedUsage, (key, value) => key === 'updatedAt' ? undefined : value);
                if (!isDeepStrictEqual(original,observed) || originalUsage !== currentUsage) throw new Error('Completed original compaction facts changed');
            } else record.after = snapshot;
            return snapshot;
        }));
        execution.evidence['history-operations'] = { present: manualSnapshots.every(s => s.operationAvailability !== 'unknown' &&
            s.operation?.phase === 'ended' && s.operation.stopped) && historyOperations.every(operation => operation.action !== 'restart-host' || operation.verified === true),
            actual: structuredClone(historyOperations),
            source: 'Original public fork/branch CAS, manual compaction and verified same-instance Host restart receipts; queries never execute history operations' };
        const subagents = await collectSubagentEvidence(client, runs.map(r => ({ runId: r.runId, sessionId: r.sessionId })));
        execution.evidence.subagents = subagents;
        if (!subagents.present) stopGaps.push(structuredClone(subagents));
        const children = z.object({ children: z.array(SubagentDetailSchema) }).passthrough().parse(subagents.actual).children;
        for (const child of children) if ((!['created', 'running'].includes(child.status) ||
            runs.some(run => run.runId === child.parentRunId && !['created', 'running'].includes(run.status))) &&
            (!child.stopConfirmed || child.cleanup.lateObservationRequired === true))
            stopGaps.push(structuredClone(child));
        const allRuns = [...runs];
        execution.evidence.runs = { present: rootsComplete && subagents.present && runs.length === runIds.length, actual: allRuns, source: 'Host query_run; original root and child product identities' };
        const childHistory:EvidenceFact[] = [];
        for (const child of children) {
            let run: z.infer<typeof runSchema>;
            try { run = await query({ type: 'query_run', runId: child.childRunId }, runSchema); }
            catch (error) { execution.evidence.runs!.present = false; stopGaps.push({ childRunId: child.childRunId, gap: String(error) }); throw error; }
            if (run.kind !== 'subagent' || run.runId !== child.childRunId || run.sessionId !== child.childSessionId ||
                run.parentRunId !== child.parentRunId || run.originToolCallId !== child.originToolCallId) {
                execution.evidence.runs!.present = false; stopGaps.push({ childRunId: child.childRunId, gap: 'Child Run origin mismatch' }); throw new Error('Child Run origin mismatch');
            }
            rememberStop(run);
            allRuns.push(run);
            childHistory.push(await collectHistoryEvidence(client, { sessionId: child.childSessionId }));
        }
        execution.evidence['subagent-history'] = { present: subagents.present && childHistory.every(h => h.present), actual: childHistory,
            source: 'Public history queries for each original child Session' };
        const inputs = (await Promise.all([...sessionIds].map(async sessionId => backward(async beforeInputId => {
            const p = await query({ type: 'list_session_inputs', input: { sessionId, beforeInputId, limit: 100 } }, SessionInputsPageSchema);
            if (p.items.some(i => i.sessionId !== sessionId || i.runId !== null && runSessions.get(i.runId) !== sessionId)) throw new Error('Foreign Session input');
            return { items: p.items, next: p.nextBeforeInputId };
        }, i => i.inputId)))).flat().sort((a, b) => b.inputId - a.inputId);
        execution.evidence.inputs = { present: true, actual: inputs, source: 'Host input ledger: delivery, consumption, original native entry' };
        const histories = await Promise.all([...sessionIds].map(sessionId => collectHistoryEvidence(client, { sessionId })));
        execution.evidence['session-histories'] = { present: histories.every(h => h.present), actual: histories,
            source: 'Pinned public native history for every original and forked Trial Session, retaining source origins and branches' };
        execution.evidence.history = histories[[...sessionIds].indexOf(sessionId)]!;
        const interactions = inputs.filter(i => i.status === 'consumed').reverse().map(input => {
            const run = runs.find(r => r.runId === input.runId);
            return { inputId: input.inputId, sessionId: input.sessionId, runId: input.runId, clientSequence: input.clientSequence,
                nativeEntryId: input.nativeEntryId, resultEntryId: input.resultEntryId, content: input.content,
                processingStatus: input.processingStatus, runStatus: run?.status ?? null,
                answer: typeof run?.output?.text === 'string' ? run.output.text : null };
        });
        execution.evidence['interaction-history'] = { present: histories.every(h => h.present) &&
            runs.every(run=>inputs.filter(input=>input.mode==='prompt'&&input.runId===run.runId&&input.status==='consumed').length===1) &&
            runs.every(run => interactions.some(i => i.runId === run.runId)) &&
            interactions.every(i => i.processingStatus === 'completed' && i.resultEntryId !== null && i.answer !== null), actual: interactions,
            source: 'Original consumed public Session inputs in inputId order and their root Run outputs; rejected/replayed requests add no turns' };
        execution.evidence['user-turns'] = { present: histories.every(h => h.present), actual: observeUserTurns(trial.turns ?? [], receipts, inputs),
            source: 'Declared later user turn IDs, actual public submission receipts and original consumed Input identities; planned turns were not sent' };
        const firstRef = inputRefs.get(steps[0]!.id)?.accepted;
        const first = inputs.find(i => firstRef ? i.inputId === firstRef.inputId && i.sessionId === firstRef.sessionId && i.runId === firstRef.runId
            : i.sessionId === initialSessionId && i.clientSequence === 1);
        execution.evidence['initial-input'] = { present: !!first, actual: first ?? null, source: 'Original first submitted Input identity and actual rendered attachment text' };
        execution.evidence['input-projection'] = { present: first?.status === 'consumed',
            actual: first && first.content.text !== initialText ? { ...execution.input, prompt: first.content.text, materials: [] } : execution.input,
            source: 'Consumed original first Input compared with the full rendered prompt and authorized attachments; observed mismatches remain present' };
        const context = [], tools = [], resources = [], eventPages = [], extensionRuns = [];
        for (const run of allRuns) {
            const sessionId = run.sessionId;
            let collected = true;
            const requests = await backward(async beforeRequestSequence => {
                const p = await query({ type: 'list_context_requests', input: { sessionId, runId: run.runId, beforeRequestSequence, limit: 20 } }, ContextRequestsPageSchema);
                if (p.sessionId !== sessionId || p.runId !== run.runId) throw new Error('Foreign context request');
                collected &&= p.collection === 'collected';
                return { items: p.items, next: p.nextBeforeRequestSequence };
            }, r => r.binding.requestSequence);
            const snapshots = await Promise.all([...new Set(requests.map(r => r.binding.snapshotId))].map(async snapshotId => {
                const detail = await query({ type: 'query_context_snapshot', input: { sessionId, runId: run.runId, snapshotId } }, ContextSnapshotDetailSchema);
                if (detail.snapshot.id !== snapshotId || detail.snapshot.runId !== run.runId || detail.snapshot.sessionId !== sessionId ||
                    requests.some(r => r.binding.snapshotId === snapshotId && r.binding.inputId !== detail.input.inputId))
                    throw new Error('Foreign original context snapshot or input binding');
                return detail;
            }));
            context.push({ runId: run.runId, collected, requests, snapshots });
            tools.push(...await backward(async beforeId => {
                const p = await query({ type: 'list_run_tool_calls', input: { runId: run.runId, sessionId, beforeId, limit: 100 } }, RuntimeToolPageSchema);
                if (p.items.some(t => t.runId !== run.runId || t.sessionId !== sessionId)) throw new Error('Foreign tool call');
                return { items: p.items, next: p.nextBeforeId };
            }, t => t.toolCallId));
            const resource = await query({ type: 'query_run_resources', input: { runId: run.runId, sessionId } }, RunResourceViewSchema);
            if (resource.runId !== run.runId || resource.sessionId !== sessionId) throw new Error('Foreign declared resources');
            resources.push(resource);
            const extension = await query({ type: 'query_run_extensions', input: { runId: run.runId, sessionId } }, RunExtensionViewSchema);
            if (extension.runId !== run.runId || extension.sessionId !== sessionId) throw new Error('Foreign declared extensions');
            extensionRuns.push(extension);
            let cursor = { runId: run.runId, lastPersistedSequence: 0 }, throughSequence: number | undefined;
            for (;;) {
                const read = RuntimeEventsReadResultSchema.parse(await client.request({ type: 'query_runtime_events', ownerToken: trial.identity.trialId,
                    input: { runId: run.runId, sessionId, cursor, throughSequence, limit: 100 } }));
                eventPages.push(read);
                if (!read.ok || read.data.nextAvailableAfterSequence !== null) break;
                const page = read.data;
                if (page.runId !== run.runId || page.sessionId !== sessionId) throw new Error('Foreign Runtime events');
                if (!page.hasMore) break;
                if (page.nextCursor.lastPersistedSequence <= cursor.lastPersistedSequence) throw new Error('Runtime event cursor did not advance');
                throughSequence ??= page.highWatermark; cursor = page.nextCursor;
            }
        }
        execution.evidence['context-requests'] = { present: subagents.present && context.every(c => c.collected), actual: context, source: 'Host actual SDK/wire inclusion; no inference from UI display' };
        for (const snapshot of manualSnapshots) {
            const operation = snapshot.operation;
            if (operation?.nativeOutcome !== 'succeeded' || !operation.generated || !operation.saved) continue;
            const record = historyOperations.find(item => item.operationId === operation.operationId)!;
            const next = steps.slice(steps.findIndex(step => step.id === record.stepId) + 1).map(step => inputRefs.get(step.id)?.accepted)
                .find(input => input?.sessionId === snapshot.sessionId);
            const entries = (histories[[...sessionIds].indexOf(snapshot.sessionId)]?.actual as { entries: HistoryEvidenceEntry[] } | undefined)?.entries ?? [];
            const saved = entries.some(entry => entry.summary.entryId === operation.entryId && entry.fields.type === 'compaction' &&
                entry.parts.some(part => part.kind === 'summary' && part.text.trim()));
            const requests = context.find(frame => frame.runId === next?.runId)?.requests ?? [];
            const included = requests.some(request => request.sdkPayload?.inclusion === 'confirmed' &&
                request.binding.includedNativeContexts?.some(binding => binding.nativeEntryId === operation.entryId && binding.entryType === 'compaction' && binding.originSessionId === snapshot.sessionId) &&
                request.attempts.some(attempt => attempt.wireInclusion === 'confirmed' && attempt.responseStatus !== null));
            const verified = saved && included && histories[[...sessionIds].indexOf(snapshot.sessionId)]?.present === true && execution.evidence['context-requests'].present;
            record.continuedUse = { verified, runId: next?.runId ?? null, summaryEntryId: operation.entryId, summaryWireInclusion: included ? 'confirmed' : 'unknown' };
        }
        execution.evidence['history-operations'].actual = structuredClone(historyOperations);
        execution.evidence.tools = { present: subagents.present, actual: tools, source: 'Host original tool execution/commit/delivery metadata; raw arguments and results are unavailable from this API' };
        execution.evidence['tool-evidence'] = await collectToolEvidence(client, tools);
        if (!subagents.present) {
            execution.evidence['tool-evidence'].present = false;
            execution.evidence['tool-evidence'].source += '; child enumeration is incomplete';
        }
        execution.evidence.resources = { present: subagents.present && resources.every(r => r.gap === null), actual: resources, source: 'Host declared resources and original reads/inclusion journal' };
        const extensionSessions = [];
        if (extensionProfile) for (const owner of new Set(allRuns.map(run => run.sessionId))) {
            try {
                const view = await query({ type: 'query_session_extensions', input: { sessionId: owner } }, SessionExtensionViewSchema);
                if (view.sessionId !== owner) throw new Error('Foreign extension Session');
                extensionSessions.push({ view, gap: null });
            } catch { extensionSessions.push({ sessionId: owner, gap: 'native-extension-view-unavailable' }); }
        }
        execution.evidence.extensions = { present: subagents.present && extensionSessions.every(s => s.gap === null) &&
            (!extensionProfile || extensionRuns.filter(r => runIds.includes(r.runId)).every(r => r.frozen?.evaluationProfile && isDeepStrictEqual(r.frozen.evaluationProfile,extensionProfile))),
            actual: { runs: extensionRuns, sessions: extensionSessions }, source: 'Original public declared Run assembly and current owned native Session Hook diagnostics; unavailable Session views remain gaps' };
        if (extensionProfile) {
            const originals = z.object({ calls: z.array(z.object({  tool: ToolCallSnapshotSchema }).passthrough()) }).passthrough()
                .parse(execution.evidence['tool-evidence'].actual);
            const calls = [];
            for (const original of originals.calls) {
                const call = original.tool;
                if (call.toolName !== 'check_invoice_sources' || call.endedAt === null) continue;
                const raw = invoiceToolSchemas.check_invoice_sources.input.safeParse(call.args.raw);
                if (!raw.success) continue;
                const code = extensionProfile.id === 'source-check-denial' ? 'eval_source_check_denied' : 'eval_source_quote_trimmed';
                const changed = extensionProfile.id === 'source-check-denial'
                    ? call.args.final === null && call.startedAt === null && call.runtimeObservation?.beforeOutcome === 'rejected'
                        && call.runtimeObservation.failureStage === 'sdk_before' && call.runtimeObservation.executionDurationMs === null
                    : call.runtimeObservation?.beforeOutcome === 'allowed' && !isDeepStrictEqual(call.args.raw, call.args.final)
                        && 'sources' in raw.data && isDeepStrictEqual(call.args.final, { ...raw.data, sources: raw.data.sources.map(source => source.quote?.trim() ? { ...source, quote: source.quote.trim() } : source) });
                if (!changed) continue;
                const assembly = extensionRuns.find(r => r.runId === call.runId && r.sessionId === call.sessionId)?.assembly;
                for (const session of extensionSessions) if (session.view?.sessionId === call.sessionId) {
                    for (const instance of session.view.instances) if (assembly?.instances.some(item => item.instanceId === instance.instanceId && item.ref.id === 'invoice-assist')) {
                        const diagnostic = instance.diagnostics.find(d => d.event === 'tool_call' && d.code === code && d.nativeToolCallId === call.nativeToolCallId &&
                            Date.parse(d.at) >= Date.parse(call.requestedAt) && Date.parse(d.at) <= Date.parse(call.endedAt!));
                        if (diagnostic) calls.push({ runId: call.runId, sessionId: call.sessionId, toolCallId: call.toolCallId,
                            nativeToolCallId: call.nativeToolCallId, instanceId: instance.instanceId, diagnosticAt: diagnostic.at,
                            diagnosticCode: diagnostic.code });
                    }
                }
            }
            const verified = execution.evidence.extensions.present && execution.evidence['tool-evidence'].present && calls.length > 0;
            execution.evidence['case-controller'] = { present: verified, actual: { profile: extensionProfile, exposure: verified ? { verified: true, calls } : null },
                source: 'Actual matching Run assembly, owned instance Hook diagnostic and original raw/final tool snapshot; configured but unobserved profiles are not exposure' };
        }
        if(futureSteer){
            const delivery=steerDelivery,input=inputs.find(input=>input.inputId===delivery?.accepted.inputId&&input.sessionId===delivery.accepted.sessionId&&input.runId===delivery.accepted.runId);
            const requests=context.find(frame=>frame.runId===delivery?.accepted.runId)?.requests??[];
            const request=input?requests.find(request=>request.sdkPayload?.inclusion==='confirmed'&&request.binding.includedBindings.some(binding=>binding.inputId===input.inputId&&binding.nativeEntryId===input.nativeEntryId&&
                binding.snapshotId===input.contextSnapshotId&&binding.originRunId===input.runId)&&request.attempts.some(attempt=>attempt.wireInclusion==='confirmed'&&attempt.responseStatus!==null)):undefined;
            const saves=tools.filter(call=>call.runId===delivery?.accepted.runId&&call.toolName==='save_invoice_candidate'&&call.startedAt!==null);
            const verified=!!delivery&&!!input&&input.mode===futureSteer.mode&&input.status==='consumed'&&input.nativeEntryId!==null&&input.content.text===userTurn(trial.turns,futureSteer.turnId).content&&!!request&&
                execution.evidence['context-requests'].present&&execution.evidence['tool-evidence'].present&&execution.evidence.history.present&&
                Date.parse(input.createdAt)>=Date.parse(delivery.read.endedAt!)&&saves.every(call=>Date.parse(call.requestedAt)>=Date.parse(input.createdAt))&&
                inputs.filter(other=>other.runId===input.runId&&other.mode===futureSteer.mode).length===1;
            execution.evidence['case-controller']={present:verified,actual:{profile:interactionProfile,exposure:verified?{verified:true,deliveries:1,consumed:true,wireInclusion:'confirmed',
                originalRunId:delivery!.accepted.runId,inputId:input!.inputId,nativeEntryId:input!.nativeEntryId,contextSnapshotId:input!.contextSnapshotId,requestSequence:request!.binding.requestSequence,
                trigger:delivery}:null},source:'Original live root/read snapshot, one public steer receipt, consumed native Input and confirmed SDK/wire inclusion; adoption and source honesty are scored separately'};
        }
        if(historySeed){
            const final=inputs.find(input=>input.sessionId===initialSessionId&&input.content.text===userTurn(trial.turns,historySeed.finalTurnId).content&&input.mode==='prompt'&&input.status==='consumed');
            const finalRequests=context.find(frame=>frame.runId===final?.runId)?.requests??[];
            const entries=(execution.evidence.history!.actual as {entries:Array<{summary:{entryId:string};fields:HistoryEntryDisplayFields;parts:Array<{kind:string;text:string}>}>}).entries;
            const summary=autoSnapshots.find(snapshot=>{
                const saved=snapshot.lastSaved,operation=snapshot.operation;
                return saved&&operation&&entries.some(entry=>entry.summary.entryId===saved.entryId&&entry.fields.type==='compaction'&&entry.fields.firstKeptEntryId===saved.firstKeptEntryId&&
                    entry.fields.tokensBefore===saved.tokensBefore&&entry.parts.some(part=>part.kind==='summary'&&part.text.trim()))&&
                    finalRequests.some(request=>request.sdkPayload?.inclusion==='confirmed'&&request.binding.includedNativeContexts?.some(binding=>binding.nativeEntryId===saved.entryId&&binding.entryType==='compaction'&&binding.originSessionId===initialSessionId)&&
                        request.attempts.some(attempt=>attempt.wireInclusion==='confirmed'&&attempt.responseStatus!==null));
            });
            const delivered=historySeed.turns.every(ref=>inputs.filter(input=>input.sessionId===initialSessionId&&input.mode==='prompt'&&input.status==='consumed'&&input.nativeEntryId!==null&&input.content.text===userTurn(trial.turns,ref.turnId).content).length===1);
            const finalIncluded=final?.nativeEntryId!==null&&finalRequests.some(request=>request.sdkPayload?.inclusion==='confirmed'&&request.binding.includedBindings.some(binding=>binding.inputId===final?.inputId&&
                binding.nativeEntryId===final.nativeEntryId&&binding.snapshotId===final.contextSnapshotId&&binding.originRunId===final.runId)&&request.attempts.some(attempt=>attempt.wireInclusion==='confirmed'&&attempt.responseStatus!==null));
            const verified=!!summary&&!!final&&finalIncluded&&inputs.length===18&&inputs.every(input=>input.mode==='prompt')&&delivered&&execution.evidence.history!.present&&execution.evidence['context-requests']!.present&&execution.evidence['interaction-history']!.present;
            execution.evidence['case-controller']={present:verified,actual:{profile:autoProfile,exposure:verified?{verified:true,seedTurns:16,finalInputConsumed:true,summaryWireInclusion:'confirmed',
                finalInputId:final!.inputId,finalRunId:final!.runId,capacity:summary!.capacity,policy:autoInitial!.policy,
                originalSummary:summary,originalAutoCompactions:autoSnapshots}:null},
                source:'Distinct consumed public user Inputs, original threshold compaction operation/capacity/saved native summary/usage and actual final SDK/wire summary inclusion; semantic retention is scored separately'};
        }
        if(cancelRaceEvidence){
            execution.evidence['case-controller']=structuredClone(cancelRaceEvidence);
            const actual=cancelRaceEvidence.actual as {exposure:{verified:boolean};stopConfirmed:boolean;stopError?:string};
            if(actual.exposure.verified&&!actual.stopConfirmed){execution.status='error';execution.error={code:'stop_unconfirmed',message:actual.stopError??'Original race stopping is unconfirmed',infrastructure:true};}
        }
        if(readExecutionFailure){
            const fact=execution.evidence['tool-evidence'];
            const originals=z.object({calls:z.array(z.object({tool:ToolCallSnapshotSchema}).passthrough())}).passthrough().parse(fact!.actual).calls.map(c=>c.tool).sort((a,b)=>a.toolCallId-b.toolCallId);
            const first=originals.find(c=>c.toolName==='read_invoice_evidence'&&c.status==='failed'&&c.result?.status==='failed'&&c.result.error.message==='Original evidence read execution failed.'&&
                c.runtimeObservation?.beforeOutcome==='allowed'&&c.runtimeObservation.failureStage==='execute'&&c.runtimeObservation.timingComplete&&c.cleanup.stopped);
            const attempts=first?originals.filter(c=>c.toolCallId>first.toolCallId&&(c.effect==='READ'||c.effect==='PURE')):[];
            const successful=attempts.some(c=>c.status==='succeeded'&&c.runtimeObservation?.afterDomain==='valid'&&c.cleanup.stopped&&c.delivery.state==='request_observed');
            execution.evidence['case-controller']={present:!!fact!.present,actual:{profile:interactionProfile,policy:{maxRecoveryAttempts:readExecutionFailure.fault.maxRecoveryAttempts},exposure:{verified:!!fact!.present&&!!first},original:first??null,
                recovery:{attempts:attempts.length,withinLimit:attempts.length<=readExecutionFailure.fault.maxRecoveryAttempts,successful,calls:attempts,recovered:attempts.length>0&&successful},
                unexpectedSaves:originals.filter(c=>c.toolName==='save_invoice_candidate')},source:'Original admitted read execution failure, unchanged permissions/budget and actual subsequent model calls'};
        }
        if(deliveryLossEvidence)execution.evidence['case-controller']=structuredClone(deliveryLossEvidence);
        else if(saveDeliveryLoss){
            const fact=execution.evidence['tool-evidence'];
            const originals=z.object({calls:z.array(z.object({tool:ToolCallSnapshotSchema}).passthrough())}).passthrough().parse(fact!.actual).calls;
            const saves=originals.filter(c=>c.tool.toolName==='save_invoice_candidate');
            const original=saves.find(c=>c.tool.status==='succeeded'&&c.tool.delivery.state==='failed'&&c.tool.delivery.error?.message==='Committed candidate model delivery failed.');
            const actual:Record<string,unknown>={profile:interactionProfile,policy:{maxRecoveryAttempts:saveDeliveryLoss.fault.maxRecoveryAttempts},exposure:{verified:false},recovery:{attempts:0,reexecuted:false}};
            if(fact!.present&&original){
                const call=original.tool,receipt=invoiceToolSchemas.save_invoice_candidate.output.safeParse(call.result?.data);
                if(receipt.success&&call.result?.committedCandidateId===receipt.data.candidateId){
                    const detail=await query({type:'query_job_candidate',input:{jobId:receipt.data.jobId,candidateId:receipt.data.candidateId}},z.object({documentRef:DocumentRefSchema,candidate:candidateSchema}).strict());
                    const history=await invoiceCandidates(receipt.data.jobId);
                    const confirmed=detail.candidate.toolCallId===call.toolCallId&&detail.candidate.runId===call.runId&&history.some(c=>c.candidateId===receipt.data.candidateId);
                    actual.original=original;actual.candidate=detail;actual.history=history;
                    actual.exposure={verified:confirmed};actual.recovery={attempts:1,reexecuted:false,confirmed,duplicateSave:saves.length!==1,
                        recovered:confirmed&&saves.length===1&&history.length===1,originalRun:await readRun(call.runId)};
                }
            }
            execution.evidence['case-controller']={present:!!fact!.present,actual,source:'One bounded read of original committed save after actual failed model delivery; original Run retained'};
            if(original)deliveryLossEvidence=structuredClone(execution.evidence['case-controller']);
        }
        if(replayEvidence)execution.evidence['case-controller']=structuredClone(replayEvidence);
        if(parentCancel){
            const cancellation=parentCancellation,verified=!!cancellation?.accepted.accepted;
            const root=allRuns.find(run=>run.runId===cancellation?.accepted.runId),after=cancellation?.observations.at(-1);
            const confirmed=verified&&!cancellation!.timedOut&&!cancellation!.observationError&&!!after&&subagents.present&&!!root&&!['created','running'].includes(root.status)&&root.stoppedAt!==null&&root.cleanup.stopped===true&&root.cleanup.lateObservationRequired!==true&&
                children.length>=cancellation!.childrenAtTrigger.length&&cancellation!.childrenAtTrigger.every(child=>children.some(item=>item.childRunId===child.childRunId))&&children.every(child=>!['created','running'].includes(child.status)&&child.stopConfirmed&&child.cleanup.lateObservationRequired!==true);
            const originals=z.object({calls:z.array(z.object({tool:ToolCallSnapshotSchema}).passthrough())}).passthrough().parse(execution.evidence['tool-evidence']!.actual).calls;
            const immutable=(entry:HistoryEvidenceEntry)=>{const {isLeaf,isCurrentPath,canSelect,cannotSelectReason,...summary}=entry.summary;return{summary,fields:entry.fields,parts:entry.parts};};
            const preserved=verified&&execution.evidence['tool-evidence']!.present&&cancellation!.reads.every(read=>originals.some(call=>call.tool.toolCallId===read.tool.toolCallId&&call.tool.runId===read.tool.runId&&call.tool.sessionId===read.tool.sessionId&&
                isDeepStrictEqual({args:call.tool.args,result:call.tool.result,effect:call.tool.effect},{args:read.tool.args,result:read.tool.result,effect:read.tool.effect})))&&
                cancellation!.historyAtTrigger.every(before=>{
                    const current=[...histories,...childHistory].find(fact=>(fact.actual as {sessionId:number}).sessionId===before.sessionId);
                    const oldEntries=(before.fact.actual as {entries:HistoryEvidenceEntry[]}).entries,newEntries=(current?.actual as {entries:HistoryEvidenceEntry[]}|undefined)?.entries;
                    return current?.present&&oldEntries.every(entry=>newEntries?.some(now=>isDeepStrictEqual(immutable(now),immutable(entry))));
                })&&cancellation!.childrenAtTrigger.every(before=>before.output===null||children.some(child=>child.childRunId===before.childRunId&&isDeepStrictEqual(child.output,before.output)));
            execution.evidence['case-controller']={present:verified,actual:{profile:interactionProfile,exposure:verified?{verified:true,cancelRequests:1,originalParentRunId:cancellation!.accepted.runId,trigger:cancellation}:null,
                stopping:cancellation?{confirmed,timedOut:cancellation.timedOut,requestOutcome:cancellation.requestOutcome,observationError:cancellation.observationError??null,originalObservation:after}:null,
                triggerObservation:parentTriggerObservation??null,committedFactsPreserved:verified?preserved:null},
                source:'Original started child Runs and delivered authorized READ snapshots/history, one public parent cancel receipt, all actual descendant stop facts and preserved committed prefixes; cancellation is not business completion'};
            if(cancellation?.timedOut||cancellation?.observationError){execution.status='error';execution.error={code:'stop_unconfirmed',message:'Original parent cancellation observation could not confirm every actual descendant stopped.',infrastructure:true};}
        }
        execution.evidence.events = { present: subagents.present && eventPages.every(p => p.ok && p.data.coverage === 'from-created' && p.data.nextAvailableAfterSequence === null),
            actual: eventPages, source: 'Host committed events, fixed page high watermark and explicit gap context' };
        let research: { task: z.infer<typeof ResearchTaskSchema> | null; reports: z.infer<typeof ResearchReportSchema>[] } | null = null;
        let candidates: Array<z.infer<typeof candidateSchema>> = [];
        let exports: ReturnType<typeof readInvoiceExports> = [];
        if (isInvoice) {
            const workspace = await query({ type: 'read_workspace' }, WorkspaceSnapshotSchema);
            const jobs = [];
            for (const [jobId, owner] of invoiceJobs) {
                const job = await query({ type: 'query_job', jobId }, jobSchema);
                if (job.jobId !== jobId || !isDeepStrictEqual(job.documentRef,owner.documentRef)) throw new Error('Foreign invoice task');
                jobs.push(job);
                const summaries = (await invoiceCandidates(jobId)).sort((a, b) => a.sequence - b.sequence);
                for (const summary of summaries) {
                    const detail = await query({ type: 'query_job_candidate', input: { jobId, candidateId: summary.candidateId } },
                        z.object({ documentRef: DocumentRefSchema, candidate: candidateSchema }).strict());
                    const candidate = detail.candidate, run = allRuns.find(r => r.runId === candidate.runId);
                    const basis = candidates.find(c => c.candidateId === candidate.basedOnCandidateId && c.jobId === jobId && c.sequence < candidate.sequence);
                    const owned = candidate.origin === 'human_edit'
                        ? candidate.runId === null && candidate.toolCallId === null && candidate.context === null && !!basis &&
                            humanCandidates.get(candidate.candidateId) === basis.candidateId
                        : !!run && run.sessionId === owner.sessionId && run.jobId === jobId && candidate.basedOnCandidateId == null;
                    if (!isDeepStrictEqual(detail.documentRef,owner.documentRef) || candidate.jobId !== jobId || candidate.candidateId !== summary.candidateId ||
                        candidate.sequence !== summary.sequence || !owned)
                        throw new Error('Invoice candidate does not belong to its original Run, Document and task');
                    candidates.push(candidate);
                }
            }
            execution.evidence.invoice = { present: true, actual: { workspace, jobs, candidates, operations: invoiceOperations },
                source: 'Original public Workspace/task CAS operations and complete paged candidate details, bound to actual Document/Run identities' };
            execution.evidence['new-candidates'] = { present: true,
                actual: candidates.map(({ candidateId, jobId, runId, sequence, origin }) => ({ candidateId, jobId, runId, sequence, origin })),
                source: 'Complete public list_job_candidates pagination for every owned Trial Job, including an observed empty ledger' };
            const current = candidates.find(c => c.candidateId === workspace.candidateRef?.id && c.jobId === workspace.jobId && c.sequence === workspace.candidateRef?.sequence);
            const savedCalls = z.object({ calls: z.array(z.object({ tool: ToolCallSnapshotSchema }).passthrough()) }).passthrough()
                .parse(execution.evidence['tool-evidence']!.actual).calls;
            const committed = candidates.filter(candidate => candidate.origin !== 'human_edit' && candidate.basedOnCandidateId == null &&
                savedCalls.some(({ tool }) => {
                    const receipt = invoiceToolSchemas.save_invoice_candidate.output.safeParse(tool.result && 'data' in tool.result ? tool.result.data : null);
                    return tool.toolName === 'save_invoice_candidate' && (tool.status === 'succeeded' || tool.runtimeObservation?.commit === 'committed') && tool.runId === candidate.runId &&
                        tool.toolCallId === candidate.toolCallId && tool.result?.committedCandidateId === candidate.candidateId &&
                        isDeepStrictEqual(tool.context, candidate.context) && receipt.success && receipt.data.candidateId === candidate.candidateId &&
                        receipt.data.jobId === candidate.jobId && receipt.data.sequence === candidate.sequence;
                }));
            let original = current;
            const lineage = new Set<number>();
            while (original) {
                lineage.add(original.candidateId);
                if (original.origin !== 'human_edit') break;
                original = candidates.find(c => c.candidateId === original!.basedOnCandidateId && c.jobId === original!.jobId && c.sequence < original!.sequence);
            }
            if (originalSelectionCandidateId !== undefined && lineage.has(originalSelectionCandidateId)) { if (!committed.includes(original!)) original = undefined; }
            else original = committed.filter(c => c.runId === [...requiredCandidateRuns].at(-1)).sort((a, b) => a.sequence - b.sequence).at(-1);
            execution.evidence['original-candidate'] = { present: !!original, actual: original ? {
                candidateId: original.candidateId, jobId: original.jobId, runId: original.runId, toolCallId: original.toolCallId, sequence: original.sequence } : null,
                source: 'Confirmed original save receipt and candidate identity; only an explicit selection after the last saving Run changes the assessed lineage' };
            execution.evidence['selected-candidate-fields'] = { present: !!current, actual: current ? Object.fromEntries(Object.entries(current.fields)
                .map(([name, field]) => [name, invoiceFieldDisplayValue(name, field)])) : null, source: 'Actual selected candidate values, including explicitly recorded user edits' };
            execution.evidence['candidate-fields'] = { present: !!original, actual: original ? Object.fromEntries(Object.entries(original.fields)
                .map(([name, field]) => [name, invoiceFieldDisplayValue(name, field)])) : null, source: 'Original model candidate bound to its confirmed save commit and receipt; later cancellation and user corrections do not rewrite it' };
            execution.evidence['candidate-line-items'] = { present: !!original, actual: original?.lines.map(line => Object.fromEntries(Object.entries(line)
                .map(([name, field]) => [name, invoiceFieldDisplayValue(name, field)]))) ?? null, source: 'Original committed model candidate lines; UI selection and user corrections remain separate' };
            execution.evidence['candidate-values'] = {present:!!original,actual:original?{fields:original.fields,lines:original.lines}:null,
                source:'Original committed model field states, raw and normalized values; no foreign, human or previous-Run fallback'};
            try { exports = readInvoiceExports(); }
            catch (error) {
                execution.evidence['invoice-exports'] = { present: false, actual: structuredClone(invoiceExports), source: 'Original public export references retained; current managed bytes failed verification' };
                throw error;
            }
            execution.evidence['invoice-exports'] = { present: true, actual: exports, source: 'Original public export references and managed file bytes rechecked against original stored bytes and size' };
            execution.endpointReached = stepsComplete && execution.status === 'completed' && !!execution.answer?.trim() &&
                [...requiredCandidateRuns].every(runId => candidates.some(c => c.runId === runId));
        } else if (isResearch) {
            const observedPlanIds = [...planRefs.values()].map(p => p.planId).concat(inputs.flatMap(i => i.content.version === 2 && i.content.research?.binding.plan ? [i.content.research.binding.plan.planId] : []));
            if (observedPlanIds.some(planId => ![...planRefs.values()].some(plan => plan.planId === planId)))
                execution.evidence.research = await collectResearchEvidence(client, { sessionId, observedPlanIds });
            execution.evidence['research-integrity'] = inspectResearchEvidence(execution.evidence.research, { runs: execution.evidence.runs!,
                tools: execution.evidence['tool-evidence'], registration: execution.evidence['material-registration']!, input: execution.input });
            const parsed = z.object({ task: ResearchTaskSchema.nullable(), reports: z.array(ResearchReportSchema) }).passthrough().safeParse(execution.evidence.research.actual);
            research = parsed.success ? parsed.data : null;
            const investigation = inputs.some(i => i.content.version === 2 && i.content.research?.binding.phase === 'researching');
            execution.endpointReached = stepsComplete && execution.status === 'completed' && execution.evidence.research.present &&
                (typeof research?.task?.currentReportId === 'number' || !investigation && typeof research?.task?.currentPlanId === 'number');
        } else {
            const jobs = await backward(async beforeId => {
                const page = await query({ type: 'list_jobs', input: { beforeId, limit: 100 } },
                    z.object({ items: z.array(jobSchema), nextBeforeId: id.nullable() }).strict());
                return { items: page.items, next: page.nextBeforeId };
            }, job => job.jobId);
            const candidates = (await Promise.all(jobs.map(job => invoiceCandidates(job.jobId)))).flat();
            execution.evidence['new-candidates'] = { present: true, actual: candidates,
                source: 'Complete original public list_jobs and list_job_candidates pages in this new owned Trial instance; empty ledger was observed' };
            execution.endpointReached = stepsComplete && execution.status === 'completed' && !!execution.answer?.trim();
        }
        if(parentCancellation?.accepted.accepted)execution.endpointReached=false;
        if(saveCancelRace&&cancelRaceEvidence)execution.endpointReached=false;
        if (historyOperations.some(operation => operation.action === 'compact-history' &&
            (operation.continuedUse as { verified?: boolean } | undefined)?.verified !== true)) execution.endpointReached = false;
        execution.evidence['task-endpoint'] = { present: isResearch ? execution.evidence.research!.present : execution.answer !== null,
            actual: execution.endpointReached, source: isResearch ? 'Completed controller steps and actual saved Plan/Report identity'
                : isInvoice ? 'Completed original invoice messages and persisted candidate for every save-candidate Run; quality is scored independently'
                : 'Completed controller steps and original final chat answer; quality is scored independently' };
        execution.evidence.answer = { present: execution.answer !== null, actual: execution.answer, source: 'Original Host Run output' };
        execution.artifacts = isInvoice ? candidates.map(candidate => ({ id: 'invoice-candidate-' + candidate.candidateId, kind: 'candidate', content: candidate }))
            : (research?.reports ?? []).map(report => ({ id: 'research-' + report.researchId + '-report-' + report.reportId, kind: 'research-report', content: report }));
        execution.artifacts.push(...exports.map(content => ({ id: 'invoice-export-' + content.reference.artifactId, kind: 'invoice-export', content })));
        execution.observations = allRuns.map(r => ({ id: trial.identity.trialId + ':run:' + r.runId,
            ...(r.kind === 'subagent' ? { parentId: trial.identity.trialId + ':run:' + r.parentRunId } : {}), kind: 'span', name: (isResearch ? 'research' : 'agent') + ' Run ' + r.runId,
            startedAt: r.startedAt ?? r.createdAt, endedAt: r.endedAt, output: r.output }));
        Object.assign(execution.usage, executionUsage(allRuns, manualSnapshots, subagents.present));
    }
    return {
        input: structuredClone(trial.input), snapshot: capture,
        async execute(external) {
            if (executed) throw new Error('Trial execute cannot replay; use snapshot for readback');
            executed = true;
            const running = AbortSignal.any([signal, external, AbortSignal.timeout(z.number().int().positive().parse(trial.configuration.timeoutMs ?? 120000))]);
            for (const step of steps) {
                running.throwIfAborted();
                if(historySeed&&step.id==='auto-final-save'&&!autoSnapshots.length)continue;
                if (step.action === 'restart-host') {
                    if (controls) {
                        const stopped = await controls.close();
                        if (!stopped.closed || !stopped.stopped) throw new Error('Form controls stopping is unconfirmed');
                        controls = undefined;
                    }
                    const keys = ['runs', 'session-histories', 'subagent-history', 'inputs', 'interaction-history',
                        'tools', 'tool-evidence', 'context-requests', 'resources', ...(isInvoice ? ['invoice'] : [])];
                    const before = await capture();
                    const runs = z.array(runSchema).parse(before.evidence.runs?.actual);
                    if (keys.some(key => !before.evidence[key]?.present) || !runs.length ||
                        runs.some(run => ['created', 'running'].includes(run.status) || run.stoppedAt === null || run.cleanup.stopped !== true) ||
                        !before.evidence['history-operations']?.present)
                        throw new Error('Host restart requires complete committed evidence and confirmed original Run stops');
                    const record: Record<string, unknown> = { stepId: step.id, action: step.action, verified: false,
                        connectionEpochBefore: client.connectionEpoch, before: Object.fromEntries(keys.map(key => [key, before.evidence[key]!.actual])) };
                    historyOperations.push(record);
                    const closed = await client.close(); record.close = closed;
                    if (!closed.ok || !closed.data.closed || !closed.data.stopped) throw new Error('Host restart stop is unconfirmed; preserve the original instance');
                    running.throwIfAborted();
                    const started = await client.start(productRoot, '0.1.0', local.runtimeRoot, invoiceSourceRoot, launch);
                    record.start = started; record.connectionEpochAfter = client.connectionEpoch;
                    if (!started.ok) throw new Error('Host restart: ' + started.error.code);
                    const after = await capture();
                    record.after = Object.fromEntries(keys.map(key => [key, after.evidence[key]!.actual]));
                    if (keys.some(key => !after.evidence[key]?.present) || !isDeepStrictEqual(record.after,record.before))
                        throw new Error('Host restart changed or lost original committed evidence');
                    record.verified = true;
                    continue;
                }
                if (step.action === 'fill-form') {
                    const selected = await selectedInvoice();
                    if (selected.job.status === 'completed' || selected.candidate.status === 'accepted') throw new Error('Fill requires an editable selected candidate');
                    controls ??= await ElectronInvoiceControls.start(options.repo, trial.directory);
                    running.throwIfAborted();
                    const epoch = client.connectionEpoch;
                    const { revision, documentRef, jobId, candidateRef } = selected.workspace;
                    const workspace = WorkspaceExpectationSchema.parse({ revision, documentRef, jobId, candidateRef, sessionId });
                    const opened = await controls.request({ action: 'open', workspace, epoch });
                    if (!opened.target) throw new Error('Original form target is unavailable');
                    client.setInvoiceFormHandler(async (request, requestEpoch) => {
                        const current = controls;
                        if (!current || requestEpoch !== epoch || client.connectionEpoch !== epoch) throw new Error('Form Host epoch changed');
                        const raw = await query({ type: 'query_run', runId: request.runId }, z.record(z.unknown()));
                        const config = z.record(z.unknown()).parse(raw.config);
                        const run = fillRunSchema.parse({ ...Object.fromEntries(['kind', 'runId', 'sessionId', 'jobId', 'scope', 'status', 'cancelRequestedAt']
                            .map(key => [key, raw[key]])), config: Object.fromEntries(['goalMode', 'formTarget', 'workspaceContext'].map(key => [key, config[key]])) });
                        const response = await current.request({ action: 'request', request, run, epoch });
                        if (!response.receipt || requestEpoch !== client.connectionEpoch) throw new Error('Original form receipt is unknown');
                        formApplications.push({ stepId: step.id, runId: run.runId, request, ...response });
                        return response.receipt;
                    });
                    const input = InvoiceFormRunInputSchema.parse({ modelId, clientSequence: nextSequences.get(sessionId) ?? 1, workspace, target: opened.target });
                    const command = { type: 'submit_invoice_form_input' as const, input, expectedSettingsRevision: settingsRevision, expectedCredentialRef: credentialRef };
                    const accepted = await query(command, desktopAcceptedSchema);
                    if (accepted.sessionId !== sessionId) throw new Error('Fill admission belongs to another Session');
                    nextSequences.set(sessionId, input.clientSequence + 1); runIds.push(accepted.runId); runSessions.set(accepted.runId, sessionId);
                    receipts.push({ stepId: step.id, action: step.action, clientSequence: input.clientSequence, requestContent: JSON.stringify(command), result: { ok: true, data: accepted } });
                    const run = await waitRun(accepted.runId, running);
                    if (run.status !== 'completed' || run.stoppedAt === null || run.cleanup.stopped !== true) throw new Error('Fill Run completion or stopping is unconfirmed');
                    const inspected = await controls.request({ action: 'inspect' });
                    invoiceOperations.push({ stepId: step.id, command, accepted, inspection: inspected.inspection });
                    continue;
                }
                if (step.action === 'edit-candidate' || step.action === 'accept-candidate' || step.action === 'reject-candidate' || step.action === 'export') {
                    const before = await selectedInvoice(), { workspace, job, candidate } = before;
                    const operationRef = randomUUID();
                    if (step.action === 'export') {
                        if (candidate.status !== 'accepted' || job.status !== 'completed' || job.acceptedCandidateId !== candidate.candidateId)
                            throw new Error('Invoice export requires the actual accepted candidate');
                        const command = { type: 'export_invoice_candidate' as const, input: { operationRef, candidateId: candidate.candidateId, format: step.format } };
                        const result = await query(command, invoiceExportSchema);
                        const readback = await query({ type: 'query_invoice_candidate_operation', input: { kind: 'export', request: command.input } }, invoiceExportSchema.nullable());
                        const path = `outputs/invoice-${job.jobId}-result-${candidate.sequence}.${step.format === 'markdown' ? 'md' : step.format}`;
                        if (result.candidateId !== candidate.candidateId || result.format !== step.format || result.relativePath !== path || !isDeepStrictEqual(readback,result))
                            throw new Error('Foreign invoice export or original operation readback');
                        invoiceExports.push(result);await rememberInvoiceExport(command.input,result);readInvoiceExports();
                        invoiceOperations.push({ stepId: step.id, command, before, result, readback });
                    } else {
                        const common = { operationRef, jobId: job.jobId, expectedCandidateId: candidate.candidateId, expectedRevision: workspace.revision };
                        const kind = step.action === 'edit-candidate' ? 'save' : step.action === 'accept-candidate' ? 'accept' : 'reject';
                        if (kind === 'save' && step.action === 'edit-candidate') {
                            const draft = InvoiceFormDraftSchema.parse({
                                fields: { ...Object.fromEntries(Object.entries(candidate.fields).map(([name, value]) => [name, invoiceFieldDisplayValue(name, value)])), ...step.patch.fields },
                                lines: step.patch.lines ?? candidate.lines.map(line => Object.fromEntries(Object.entries(line).map(([name, value]) => [name, invoiceFieldDisplayValue(name, value)]))),
                                notes: step.patch.notes ?? candidate.notes
                            });
                            const command = { type: 'save_invoice_candidate' as const, input: { ...common, basedOnCandidateId: candidate.candidateId, draft,
                                ...(step.lineOrigins !== undefined ? { lineOrigins: step.lineOrigins } : {}) } };
                            const response = z.object({ changed: z.boolean(), candidate: candidateSchema, workspace: WorkspaceSnapshotSchema }).strict();
                            const result = await query(command, response);
                            const readback = await query({ type: 'query_invoice_candidate_operation', input: { kind: 'save', request: command.input } }, response.nullable());
                            if (result.candidate.jobId !== job.jobId || result.workspace.sessionId !== sessionId || !isDeepStrictEqual(result.workspace.documentRef,job.documentRef) ||
                                result.workspace.candidateRef?.id !== result.candidate.candidateId || result.workspace.candidateRef.sequence !== result.candidate.sequence ||
                                (result.changed ? result.candidate.origin !== 'human_edit' || result.candidate.runId !== null || result.candidate.basedOnCandidateId !== candidate.candidateId ||
                                    !readback || !isDeepStrictEqual(readback.candidate,result.candidate) || readback.workspace.revision !== result.workspace.revision
                                    : !isDeepStrictEqual(result.candidate,candidate) || readback !== null || result.workspace.revision !== workspace.revision))
                                throw new Error('Invoice edit lacks its original candidate lineage or save receipt');
                            if (result.changed) humanCandidates.set(result.candidate.candidateId, candidate.candidateId);
                            editedCandidates.set(step.id, { jobId: job.jobId, candidateId: result.candidate.candidateId, sequence: result.candidate.sequence });
                            invoiceOperations.push({ stepId: step.id, command, before, result, readback });
                        } else {
                            const command = step.action === 'accept-candidate'
                                ? { type: 'accept_invoice_candidate' as const, input: { ...common, candidateId: candidate.candidateId, dirty: false as const } }
                                : { type: 'reject_invoice_candidate' as const, input: { ...common, candidateId: candidate.candidateId, reason: step.action === 'reject-candidate' ? step.reason : '' } };
                            const response = z.object({ candidate: candidateSchema, job: jobSchema, workspace: WorkspaceSnapshotSchema }).strict();
                            const result = await query(command, response);
                            const readback = await query({ type: 'query_invoice_candidate_operation', input: command.type === 'accept_invoice_candidate'
                                ? { kind: 'accept', request: command.input } : { kind: 'reject', request: command.input } }, response.nullable());
                            if (result.candidate.candidateId !== candidate.candidateId || result.candidate.jobId !== job.jobId || result.job.jobId !== job.jobId ||
                                !isDeepStrictEqual(result.job.documentRef,job.documentRef) || result.workspace.sessionId !== sessionId ||
                                (kind === 'accept' ? result.workspace.candidateRef?.id !== candidate.candidateId || result.job.currentCandidateId !== candidate.candidateId
                                    : result.workspace.candidateRef !== null || result.job.currentCandidateId !== null) || !isDeepStrictEqual(result.workspace.documentRef,job.documentRef) ||
                                result.candidate.status !== (kind === 'accept' ? 'accepted' : 'rejected') ||
                                kind === 'accept' && (result.job.acceptedCandidateId !== candidate.candidateId || result.job.status !== 'completed') ||
                                !readback || !isDeepStrictEqual(readback.candidate,result.candidate) || readback.workspace.revision !== result.workspace.revision)
                                throw new Error('Invoice decision belongs to another candidate, Workspace or original operation');
                            invoiceOperations.push({ stepId: step.id, command, before, result, readback });
                        }
                    }
                    continue;
                }
                if (step.action === 'select-candidate') {
                    const prior = inputRefs.get(step.fromStep), edited = editedCandidates.get(step.fromStep);
                    const run = prior ? await readRun(prior.accepted.runId) : null;
                    const jobId = id.parse(edited?.jobId ?? run?.jobId), workspace = await query({ type: 'read_workspace' }, WorkspaceSnapshotSchema);
                    const job = await query({ type: 'query_job', jobId }, jobSchema);
                    const candidates = (await invoiceCandidates(jobId)).filter(c => edited
                        ? c.candidateId === edited.candidateId && c.sequence === edited.sequence : c.runId === run?.runId).sort((a, b) => a.sequence - b.sequence);
                    const candidate = candidates[step.ordinal - 1];
                    if (!candidate || !invoiceJobs.has(jobId) || workspace.jobId !== jobId || workspace.sessionId !== sessionId ||
                        !isDeepStrictEqual(workspace.documentRef,job.documentRef) || workspace.candidateRef?.id !== job.currentCandidateId && job.currentCandidateId !== null)
                        throw new Error('Invoice selection lacks the original candidate in the current task');
                    const command = { type: 'select_candidate' as const, input: { jobId, candidateId: candidate.candidateId,
                        expectedCandidateId: job.currentCandidateId, expectedRevision: workspace.revision } };
                    const result = await query(command, z.object({ jobId: id, candidateId: id, workspace: WorkspaceSnapshotSchema }).strict());
                    if (result.jobId !== jobId || result.candidateId !== candidate.candidateId || result.workspace.candidateRef?.id !== candidate.candidateId ||
                        result.workspace.candidateRef.sequence !== candidate.sequence || result.workspace.sessionId !== sessionId)
                        throw new Error('Foreign invoice candidate selection receipt');
                    invoiceOperations.push({ stepId: step.id, fromStep: step.fromStep, command, before: workspace, result });
                    originalSelectionCandidateId = candidate.candidateId;
                    continue;
                }
                if (step.action === 'fork-history' || step.action === 'branch-history') {
                    const prior = inputRefs.get(step.fromStep)!;
                    const input = (await query({ type: 'query_session_input', input: { sessionId: prior.accepted.sessionId, inputId: prior.accepted.inputId } }, SessionInputQueryResultSchema)).input;
                    if (!input || input.sessionId !== sessionId || input.inputId !== prior.accepted.inputId || input.runId !== prior.accepted.runId ||
                        input.status !== 'consumed' || input.processingStatus !== 'completed') throw new Error('History target lacks an original completed input in the current Session');
                    const targetEntryId = step.target === 'user' ? input.nativeEntryId : input.resultEntryId;
                    if (targetEntryId === null) throw new Error('Original history target entry is unavailable');
                    const before = await query({ type: 'query_session_history', input: { sessionId, limit: 1 } }, NativeHistoryPageSchema);
                    if (before.session.sessionId !== sessionId) throw new Error('Foreign history CAS');
                    if (step.action === 'fork-history') {
                        const command = { type: 'fork_session' as const, input: { sourceSessionId: sessionId, expected: before.commit,
                            targetEntryId, title: step.title, clientOperationId: randomUUID() } };
                        const result = await query(command, ForkSessionResultSchema);
                        if (result.sourceSessionId !== sessionId || result.selectedEntryId !== targetEntryId) throw new Error('Foreign fork receipt');
                        historyOperations.push({ stepId: step.id, action: step.action, command, before, result });
                        sessionId = result.session.sessionId; sessionIds.add(sessionId);
                    } else {
                        const command = { type: 'branch_session' as const, input: { sessionId, targetEntryId, expectedLeafId: before.commit.leafId,
                            expectedEntryCount: before.commit.entryCount, expectedCommitRevision: before.commit.commitRevision } };
                        const response = BranchSessionResponseSchema.parse(await client.request(command));
                        if (!response.ok) throw new Error('branch_session: ' + response.error.code);
                        if (response.data.session.sessionId !== sessionId || response.data.leafId !== targetEntryId) throw new Error('Foreign branch receipt');
                        historyOperations.push({ stepId: step.id, action: step.action, command, before, result: response.data });
                    }
                    continue;
                }
                if (step.action === 'compact-history') {
                    const before = await query({ type: 'query_session_compaction', input: { sessionId } }, SessionCompactionSnapshotSchema);
                    if (before.sessionId !== sessionId || !before.manualAllowed) throw new Error('Manual compaction is not admitted: ' + before.blockCode);
                    const owner = { sessionId, operationId: randomUUID() };
                    const command = { type: 'compact_session' as const, input: { ...owner, expected: before.commit, modelId },
                        expectedSettingsRevision: settingsRevision, expectedCredentialRef: credentialRef };
                    const record: Record<string, unknown> = { stepId: step.id, action: step.action, operationId: owner.operationId, command, before };
                    historyOperations.push(record); compactions.push(owner);
                    record.result = await query(command, CompactionAcceptedSchema);
                    for (;;) {
                        running.throwIfAborted();
                        const after = await query({ type: 'query_session_compaction', input: owner }, SessionCompactionSnapshotSchema);
                        record.after = after;
                        if (after.sessionId !== owner.sessionId || !after.operation || after.operation.operationId !== owner.operationId)
                            throw new Error('Original compaction operation is unavailable');
                        if (after.operation.phase === 'ended' && after.operation.stopped) {
                            if (after.operation.nativeOutcome !== 'succeeded' || !after.operation.generated || !after.operation.saved || !after.operation.mayContinue) {
                                const error = after.operation.error;
                                record.outcome = error?.code === 'compaction_not_needed' ? 'no-work' : 'failed';
                                controllerFailure = { code: error?.code ?? 'compaction_failed', message: error?.message ?? 'Manual compaction did not produce a usable original summary.', infrastructure: false };
                                return capture();
                            }
                            break;
                        }
                        await delay(50, undefined, { signal: running });
                    }
                    continue;
                }
                const replay = step.action === 'research-replay' || step.action === 'input-replay' ? inputRefs.get(step.fromStep)! : null;
                const plan = step.action === 'research-confirm' ? planRefs.get(step.planFromStep)! : null;
                let workspace = step.action === 'invoice-message' ? await invoiceWorkspace(step.sample, step.instruction, step.workspaceMode, step.id) : null;
                if (isInvoice && step.action === 'user-message') {
                    const current = await query({ type: 'read_workspace' }, WorkspaceSnapshotSchema);
                    if (current.sessionId !== sessionId || !invoiceRegistration.some(item => isDeepStrictEqual(item.document.documentRef,current.documentRef)) ||
                        current.jobId !== null && !invoiceJobs.has(current.jobId)) throw new Error('Invoice follow-up has no authorized current Workspace');
                    const { revision, documentRef, jobId, candidateRef } = current;
                    workspace = WorkspaceExpectationSchema.parse({ revision, documentRef, jobId, candidateRef, sessionId });
                }
                const laterTurn = 'turnId' in step && step.turnId ? userTurn(trial.turns, step.turnId) : undefined;
                const activeMode = laterTurn?.mode === 'steer' || laterTurn?.mode === 'followUp' ? laterTurn.mode : null;
                const activeRun = activeMode ? [...runIds].reverse().find(id => runSessions.get(id) === sessionId) : undefined;
                if (activeMode && activeRun === undefined) throw new Error('Active user turn requires an original target Run');
                const command: InputCommand = replay?.command ?? (activeMode ? { type: 'submit_session_input', input: { sessionId, runId: activeRun!,
                    clientSequence: nextSequences.get(sessionId) ?? 1, mode: activeMode, text: laterTurn!.content, ...(workspace ? { workspace } : {}) } } : { type: 'submit_session_input', input: { sessionId, clientSequence: nextSequences.get(sessionId) ?? 1,
                    mode: 'prompt', goalMode: step.action === 'invoice-message' ? step.goalMode : 'answer',
                    text: step.id === steps[0]!.id ? initialText : 'instruction' in step ? step.instruction : '', modelId,
                    ...(workspace ? { workspace } : {}),
                    ...(workspace && trial.privateEffects ? { workingDirectory: trial.privateEffects.workingDirectory } : {}),
                    ...(isResearch ? { research: { researchId: researchId!, phase: plan ? 'researching' as const : 'planning' as const, plan: plan ? { planId: plan.planId,
                        revision: plan.revision + (step.action === 'research-confirm' ? step.revisionOffset : 0) } : null } } : {}) },
                    expectedSettingsRevision: settingsRevision, expectedCredentialRef: credentialRef });
                const submitted:StepReceipt={ stepId: step.id, ...(!replay && laterTurn ? {turnId:laterTurn.id} : {}), action: step.action, clientSequence: command.input.clientSequence, requestContent: JSON.stringify(command), result:{pending:true} };
                receipts.push(submitted);
                const result = z.union([z.object({ ok: z.literal(true), data: desktopAcceptedSchema }).strict(),
                    z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).parse(await client.request(command));
                submitted.result=result;
                const expected = step.action === 'research-confirm' ? step.expected : 'accepted';
                if (!result.ok) {
                    if (result.error.code !== expected) throw new Error('Research step ' + step.id + ': ' + result.error.code + ': ' + result.error.message);
                    continue;
                }
                if (expected !== 'accepted') throw new Error('Research step accepted a request expected to be rejected');
                if (result.data.sessionId !== command.input.sessionId) throw new Error('Accepted input belongs to another Session');
                const accepted = { inputId: result.data.inputId, sessionId: result.data.sessionId, runId: result.data.runId };
                if (replay && !isDeepStrictEqual(accepted,replay.accepted)) throw new Error('Replay created a different input or Run');
                if (!replay) { nextSequences.set(sessionId, command.input.clientSequence + 1); inputRefs.set(step.id, { command, accepted }); }
                if (!runIds.includes(result.data.runId)) { runIds.push(result.data.runId); runSessions.set(result.data.runId, result.data.sessionId); }
                if (!replay && step.action === 'invoice-message' && step.goalMode === 'save-candidate') {
                    requiredCandidateRuns.add(result.data.runId); originalSelectionCandidateId = undefined;
                }
                if(parentCancel&&await cancelActualParent(result.data.runId,running))break;
                if(saveCancelRace){const race=await cancelOriginalSave(client,{runId:result.data.runId,sessionId},running,readRun);cancelRaceEvidence=race.evidence;if(race.cancelled)break;}
                if(!replay&&step.action==='invoice-message'&&futureSteer)await deliverSteer(result.data.runId,running);
                await replayOriginalSave(result.data.runId,running);
                const run = await waitRun(result.data.runId, running);
                if(run.status==='failed'&&await recoverDeliveredSave(run.runId,running))continue;
                if (run.status !== 'completed' || run.stoppedAt === null || run.cleanup.stopped !== true || run.cleanup.lateObservationRequired === true)
                    return capture();
                if(autoProfile){
                    const snapshot=await query({type:'query_session_compaction',input:{sessionId,runId:run.runId}},SessionCompactionSnapshotSchema);
                    if(snapshot.sessionId!==sessionId||!isDeepStrictEqual(snapshot.policy,autoInitial!.policy)||snapshot.capacity.contextWindow!==config.modelCapabilities.contextWindow||snapshot.capacity.thresholdTokens!==config.modelCapabilities.contextWindow-autoProfile.reserveTokens)
                        throw new Error('Actual native compaction capacity differs from the declared controller');
                    const operation=snapshot.operation,saved=snapshot.lastSaved;
                    if(operation?.runId===run.runId&&operation.reason==='threshold'&&operation.phase==='ended'&&operation.nativeOutcome==='succeeded'&&operation.generated&&operation.stopped&&operation.saved&&
                        saved?.entryId===operation.entryId&&saved.tokensBefore>snapshot.capacity.thresholdTokens&&operation.capacity.fitsEstimate===true)
                        autoSnapshots.push(snapshot);
                }
                if (step.action === 'research-plan') {
                    const task = await query({ type: 'query_research_task', input: { researchId: researchId! } }, ResearchTaskSchema);
                    if (task.sessionId !== sessionId || task.currentRunId !== run.runId || task.currentPlanId === null || task.status !== 'awaiting_confirmation')
                        throw new Error('Planning Run did not save an actual Plan for confirmation');
                    const saved = await query({ type: 'query_research_plan', input: { researchId: researchId!, planId: task.currentPlanId } }, ResearchPlanSchema);
                    if (saved.researchId !== researchId || saved.planId !== task.currentPlanId || saved.runId !== run.runId) throw new Error('Saved Plan identity mismatch');
                    planRefs.set(step.id, { planId: saved.planId, revision: saved.revision });
                }
            }
            stepsComplete = true;
            return capture();
        },
        async cancel() {
            if (controls) await controls.request({ action: 'cancel' });
            for (const owner of compactions) {
                const snapshot = await query({ type: 'query_session_compaction', input: owner }, SessionCompactionSnapshotSchema);
                if (snapshot.operation?.operationId !== owner.operationId) throw new Error('Cannot confirm original compaction before cancellation');
                if (!snapshot.operation.stopped) {
                    await query({ type: 'cancel_session_compaction', input: owner }, z.unknown());
                    const stopping = AbortSignal.timeout(z.number().int().positive().parse(trial.configuration.stopGraceMs ?? 5000));
                    for (;;) {
                        stopping.throwIfAborted();
                        const after = await query({ type: 'query_session_compaction', input: owner }, SessionCompactionSnapshotSchema);
                        if (after.operation?.operationId !== owner.operationId) throw new Error('Original compaction stopping is unknown');
                        historyOperations.find(item => item.operationId === owner.operationId)!.after = after;
                        if (after.operation.phase === 'ended' && after.operation.stopped) break;
                        await delay(50, undefined, { signal: stopping });
                    }
                }
            }
            for (const runId of runIds) {
                const run = await readRun(runId);
                if (['created', 'running'].includes(run.status)&&parentCancellation?.accepted.runId!==runId) await query({ type: 'cancel_run', runId }, z.unknown());
            }
        },
        close: closeHost
    };
}

export const prepareHostResearchTrial = prepareHostTrial;
