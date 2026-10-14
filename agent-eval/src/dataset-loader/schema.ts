import { z } from 'zod';
import { metricCatalog } from '../scoring/catalog.ts';
import { compactPlanSchema } from '../scoring/judges/compact.ts';
import {scoringMetric} from '../scoring/diagnostic-plans.ts';
import {researchGoldSchema as researchGold} from './research-gold.ts';
import { InvoiceFormDraftSchema, InvoiceFormLineOriginsSchema } from '../../../packages/contracts/src/invoice.ts';
import { ExtensionEvaluationProfileSchema, ExtensionRefSchema } from '../../../packages/contracts/src/extensions.ts';
import { constraintShape, validateConstraints, userTurnSchema, turnIdSchema, difficultySchema, caseSourceSchema } from './authoring.ts';

const id = z.string().regex(/^(?:[a-z0-9][a-z0-9-]*|FM-\d{3})$/), sha = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().trim().min(1);
const instruction = z.string().refine(value => value.trim().length > 0, 'Instruction must contain text');
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const relativeFile = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const metricIds = ['task-result', 'input-isolation', 'environment-isolation', 'no-secret', 'closed', 'fact-check', 'reference-fields', 'line-items', 'answer-relevance'] as const;
export const checkSchema = z.object({
    metric: z.enum(metricIds), required: z.boolean(), evidence: z.string().min(1).optional(), trigger:z.literal('started').optional(),
    path: z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).optional(), equals: z.unknown().optional(),
    description: z.string().min(1).optional(), operator: z.enum(['equals', 'includes']).optional(),
    compareTo: z.object({ evidence: z.string().min(1), path: z.array(z.union([z.string().min(1), z.number().int().nonnegative()])) }).strict().optional()
}).strict().superRefine((v, c) => {
    if (v.metric === 'fact-check' && (!v.evidence || !v.path || (('equals' in v) === !!v.compareTo)))
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'fact-check needs evidence/path and exactly one of equals or compareTo' });
    if (v.metric !== 'fact-check' && (v.compareTo || v.operator || v.path || 'equals' in v))
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'Comparison options only apply to fact-check' });
    if(v.trigger&&v.metric!=='fact-check')c.addIssue({code:'custom',message:'Started process checks must be deterministic fact-checks'});
});
export const materialSchema = z.object({ source: z.literal('voxel51'), sample: z.string().regex(/^\d{6}$/), file: z.enum(['content.md', 'content.json', 'pages.json']), sha256: sha, originalSha256: sha }).strict();
export const caseMaterialSchema = z.union([materialSchema, z.object({ source: z.literal('local-text'), sample: id,
    file: relativeFile.refine(file => /\.(txt|md)$/.test(file), 'Only declared text or Markdown'), sha256: sha, originalSha256: sha,
    originalFile: relativeFile.optional() }).strict()]);
const caseBase = z.object({
    id, version: z.number().int().positive(), name: z.string().min(1), category: id, tags: z.array(id).min(1), requires: z.array(id).min(1),
    difficulty: difficultySchema.optional(), purpose: z.enum(['capability', 'regression']).optional(), source: caseSourceSchema.optional(),
    input: z.object({ prompt: z.string().min(1), turns: z.array(userTurnSchema).min(1).optional(), materials: z.array(materialSchema).default([]) }).strict(),
    setup: z.object({ scenario: id, description: z.string().min(1), resources: z.array(z.object({ id, version: z.number().int().positive(), content: z.string().min(1) }).strict()).min(1).optional() }).strict().optional(),
    steps: z.array(z.object({ action: z.enum(['user-message', 'restart', 'compact', 'restore-tool', 'edit-candidate', 'accept-candidate', 'export']), instruction: z.string().min(1) }).strict()).min(1).optional(),
    expected: z.object({
        ...constraintShape,
        success: z.array(z.string().min(1)).min(1), failure: z.array(z.string().min(1)).min(1), checks: z.array(checkSchema).min(1),
        reference: z.object({ status: z.enum(['pending', 'verified']), fields: z.record(z.string(), z.string()).refine(v => Object.keys(v).length > 0), lineItems: z.array(z.record(z.string(), z.string())).min(1).optional(), excerpt: z.string().min(1), basis: z.literal('visible-parsed-material') }).strict().optional()
    }).strict(), review: z.object({ status: z.literal('pending') }).strict()
}).strict();
function references(v: Pick<z.infer<typeof caseBase>, 'expected'>, c: z.RefinementCtx) {
    if (v.expected.checks.some(k => k.metric === 'reference-fields' || k.metric === 'line-items') && !v.expected.reference)
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'Selected reference grader requires reference facts' });
    if (v.expected.checks.some(k => k.metric === 'line-items') && !v.expected.reference?.lineItems?.length)
        c.addIssue({ code: z.ZodIssueCode.custom, message: 'Line grading requires reference lineItems' });
}
export const caseSchema = caseBase.superRefine((value,context)=>{
    references(value,context);
    validateConstraints(value.expected,context);
    if(value.expected.checks.some(check=>check.trigger))context.addIssue({code:'custom',message:'Process checks require versioned Case v2'});
});
const manifestV1 = z.object({
    contract: z.literal('flowmate-agent-dataset/v1'), id, version: z.number().int().positive(), name: z.string().min(1),
    members: z.array(z.string().min(1)).min(1), smoke: z.array(id), suite: z.enum(['baseline', 'badcase']).optional(),
    environment: z.object({ profile: z.literal('isolated-agent/v1'), source: z.literal('voxel51'), risks: z.array(z.string().min(1)).min(1) }).strict(),
    scoring: z.object({ version: z.number().int().positive(), required: z.array(z.enum(metricIds)), judges: z.array(z.object({ id: z.literal('answer-relevance'), required: z.boolean(), requiredFor: z.array(id).optional() }).strict()).max(1) }).strict()
}).strict();

export const metricPlanSchema = z.object({ metricId: text, version: integer.positive(), unit: text,
    denominator: integer.nullable().optional(), notApplicable: text.optional() }).strict().superRefine((v, c) => {
    const metric = metricCatalog.find(m => m.id === v.metricId);
    if (!metric || metric.version !== v.version || metric.unit !== v.unit)
        c.addIssue({ code: 'custom', message: 'Unknown metric identity, version or unit' });
    if (v.notApplicable !== undefined ? v.denominator !== undefined : v.denominator === undefined)
        c.addIssue({ code: 'custom', message: 'Metric needs denominator or explicit non-applicability, never both' });
    if (v.metricId === 'task-success' && (v.denominator !== 1 || v.notApplicable !== undefined))
        c.addIssue({ code: 'custom', message: 'Task success applies once to every Trial' });
    if (v.metricId === 'DR03' && !v.notApplicable && v.denominator !== null)
        c.addIssue({ code: 'custom', message: 'DR03 is locally derived and has no count denominator' });
});
const messageInputShape = { instruction: instruction.optional(), turnId: turnIdSchema.optional() };
export const researchStepSchema = z.discriminatedUnion('action', [
    z.object({ id, action: z.literal('research-plan'), ...messageInputShape }).strict(),
    z.object({ id, action: z.literal('research-confirm'), ...messageInputShape, planFromStep: id,
        revisionOffset: z.union([z.literal(0), z.literal(1)]).default(0),
        expected: z.enum(['accepted', 'research_plan_stale', 'research_already_started']).default('accepted') }).strict(),
    z.object({ id, action: z.literal('research-replay'), fromStep: id }).strict()
]);
export const historyStepSchema = z.discriminatedUnion('action', [
    z.object({ id, action: z.literal('user-message'), ...messageInputShape }).strict(),
    z.object({ id, action: z.literal('fork-history'), fromStep: id, target: z.enum(['user', 'result']), title: text.max(120) }).strict(),
    z.object({ id, action: z.literal('branch-history'), fromStep: id, target: z.enum(['user', 'result']) }).strict(),
    z.object({ id, action: z.literal('compact-history') }).strict(),
    z.object({ id, action: z.literal('restart-host') }).strict(),
    z.object({ id, action: z.literal('input-replay'), fromStep: id }).strict()
]);
export const invoiceStepSchema = z.discriminatedUnion('action', [
    z.object({ id, action: z.literal('invoice-message'), ...messageInputShape,
        sample: id, goalMode: z.enum(['answer', 'save-candidate']),
        workspaceMode: z.enum(['start-task', 'selected-document', 'new-session']).optional() }).strict(),
    z.object({ id, action: z.literal('select-candidate'), fromStep: id, ordinal: integer.positive() }).strict(),
    z.object({ id, action: z.literal('fill-form') }).strict(),
    z.object({ id, action: z.literal('edit-candidate'), patch: InvoiceFormDraftSchema.partial().extend({
        fields: InvoiceFormDraftSchema.shape.fields.partial().optional()
    }).strict().refine(patch => Object.keys(patch.fields ?? {}).length > 0 || patch.lines !== undefined || patch.notes !== undefined,
        'An edit needs explicit user changes'), lineOrigins: InvoiceFormLineOriginsSchema.optional() }).strict(),
    z.object({ id, action: z.literal('accept-candidate') }).strict(),
    z.object({ id, action: z.literal('reject-candidate'), reason: text.max(256) }).strict(),
    z.object({ id, action: z.literal('export'), format: z.enum(['json', 'csv', 'markdown']) }).strict()
]);
export const controllerStepSchema = z.union([researchStepSchema, historyStepSchema, invoiceStepSchema]).superRefine((step,context)=>{
    if (['research-plan','research-confirm','user-message','invoice-message'].includes(step.action) &&
        (('instruction' in step && step.instruction !== undefined) === ('turnId' in step && step.turnId !== undefined)))
        context.addIssue({code:'custom',message:'Message step requires exactly one of instruction or turnId'});
});
const legacyStepSchema = caseBase.shape.steps.unwrap().element;
function stepReferences(steps: Array<z.infer<typeof controllerStepSchema> | z.infer<typeof legacyStepSchema>>, c: z.RefinementCtx) {
    const earlier = new Map<string, z.infer<typeof controllerStepSchema>>();
    for (const step of steps) {
        if (!('id' in step)) continue;
        if (step.action === 'invoice-message' && step.workspaceMode && step.workspaceMode !== 'start-task' && step.goalMode !== 'answer')
            c.addIssue({ code: 'custom', message: 'Browsing or New Session cannot implicitly start a saving task' });
        if (earlier.has(step.id)) c.addIssue({ code: 'custom', message: 'Duplicate controller step identity' });
        if (step.action === 'restart-host' && !earlier.size)
            c.addIssue({ code: 'custom', message: 'Host restart requires an earlier original step' });
        if (step.action === 'research-confirm' && earlier.get(step.planFromStep)?.action !== 'research-plan')
            c.addIssue({ code: 'custom', message: 'Confirmation requires an earlier Plan step' });
        if (step.action === 'research-replay') {
            const prior = earlier.get(step.fromStep);
            if (!prior || prior.action !== 'research-plan' && !(prior.action === 'research-confirm' && prior.expected === 'accepted'))
                c.addIssue({ code: 'custom', message: 'Replay requires an earlier accepted research input step' });
        }
        if (step.action === 'select-candidate' && (!['invoice-message', 'edit-candidate'].includes(earlier.get(step.fromStep)?.action ?? '') ||
            earlier.get(step.fromStep)?.action === 'edit-candidate' && step.ordinal !== 1))
            c.addIssue({ code: 'custom', message: 'Candidate selection requires an earlier invoice message or its actual edited version' });
        if (step.action === 'edit-candidate' && ((step.patch.lines !== undefined) !== (step.lineOrigins !== undefined) ||
            step.patch.lines !== undefined && step.lineOrigins?.length !== step.patch.lines.length))
            c.addIssue({ code: 'custom', message: 'Edited lines require explicit matching line origins' });
        if ((step.action === 'fork-history' || step.action === 'branch-history' || step.action === 'input-replay') &&
            !['user-message', 'invoice-message'].includes(earlier.get(step.fromStep)?.action ?? ''))
            c.addIssue({ code: 'custom', message: 'History and replay require an earlier original message step' });
        earlier.set(step.id, step);
    }
}
export const controllerStepsSchema = z.array(controllerStepSchema).min(1).superRefine(stepReferences);
const controllerBindingSchema=z.object({relativePath:z.string().regex(/^quality-controls\/(?:[a-z0-9-]+|FM-\d{3})\/controller\.json$/),sha256:sha}).strict();
export const interactionProfileSchema=z.discriminatedUnion('id',[
    z.object({id:z.literal('invoice-save-replay'),version:z.literal(1)}).strict(),
    z.object({id:z.literal('invoice-save-delivery-loss'),version:z.literal(1)}).strict(),
    z.object({id:z.literal('invoice-read-execution-failure'),version:z.literal(1)}).strict(),
    z.object({id:z.literal('invoice-save-cancel-race'),version:z.literal(1)}).strict(),
    z.object({id:z.literal('invoice-currency-steer'),version:z.literal(1)}).strict(),
    z.object({id:z.literal('invoice-auto-compaction'),version:z.literal(1),reserveTokens:z.literal(16384),keepRecentTokens:z.literal(20000)}).strict(),
    z.object({id:z.literal('invoice-parent-cancel'),version:z.literal(1)}).strict(),
]);
export type InteractionProfile=z.infer<typeof interactionProfileSchema>;
export const saveCancelRaceControllerSchema=z.object({contract:z.literal('flowmate-case-controller-spec/v1'),version:z.literal(1),caseId:id,
    handlerStatus:z.literal('implemented-controlled-host'),actualExposure:z.literal('not-run'),
    identityResolution:z.object({from:z.literal('this-trial-original-public-receipts'),preallocatedProductIds:z.literal(false)}).strict(),notExposedOutcome:z.literal('UNJUDGEABLE'),
    trigger:z.object({phase:z.literal('original-save-admitted-entering-commit'),tool:z.literal('save_invoice_candidate'),requireActualInFlightSave:z.literal(true)}).strict(),
    cancel:z.object({command:z.literal('cancel_run'),target:z.literal('actual-owner-run'),maxRequests:z.literal(1),
        validLinearizations:z.tuple([z.literal('cancel-before-commit'),z.literal('commit-before-cancel'),z.literal('commit-unknown')]),rollbackCommittedCandidate:z.literal(false),
        requestReceiptIsStopConfirmation:z.literal(false),expectedCandidateCountBeforeLinearizationKnown:z.null(),neverResubmitSave:z.literal(true),verifyAllActualDescendants:z.literal(true),
        timeoutOutcome:z.literal('UNJUDGEABLE;block-next-trial-until-stopped')}).strict()}).passthrough();
export const readExecutionFailureControllerSchema=z.object({contract:z.literal('flowmate-case-controller-spec/v1'),version:z.literal(1),caseId:id,
    handlerStatus:z.literal('implemented-controlled-host'),actualExposure:z.literal('not-run'),
    identityResolution:z.object({from:z.literal('this-trial-original-public-receipts'),preallocatedProductIds:z.literal(false)}).strict(),notExposedOutcome:z.literal('UNJUDGEABLE'),
    trigger:z.object({phase:z.literal('first-actual-read-execution'),tool:z.literal('read_invoice_evidence'),requireAdmittedOriginalRequest:z.literal(true)}).strict(),
    fault:z.object({id:z.literal('case-evidence-read-execution-failure'),version:z.literal(1),registered:z.literal(true),phase:z.literal('execution-before-success'),tool:z.literal('read_invoice_evidence'),
        maxActivations:z.literal(1),maxRecoveryAttempts:z.literal(1),preserveNormalPermissions:z.literal(true),errorMustBeOriginalExecutionFailure:z.literal(true),remainingRuntimeBudgetStillApplies:z.literal(true)}).strict()}).passthrough();
export const saveDeliveryLossControllerSchema=z.object({contract:z.literal('flowmate-case-controller-spec/v1'),version:z.literal(1),caseId:id,
    recoveryTurnId:turnIdSchema.optional(),
    handlerStatus:z.literal('implemented-controlled-host'),actualExposure:z.literal('not-run'),
    identityResolution:z.object({from:z.literal('this-trial-original-public-receipts'),preallocatedProductIds:z.literal(false)}).strict(),notExposedOutcome:z.literal('UNJUDGEABLE'),
    trigger:z.object({phase:z.literal('original-save-committed-before-result-delivery'),tool:z.literal('save_invoice_candidate'),requireActualCommit:z.literal(true)}).strict(),
    fault:z.object({id:z.literal('case-save-delivery-loss'),version:z.literal(1),registered:z.literal(true),phase:z.literal('after-commit-before-delivery'),tool:z.literal('save_invoice_candidate'),
        maxActivations:z.literal(1),dropOriginalModelDeliveryOnly:z.literal(true),preserveOriginalCommitReceipt:z.literal(true),reexecuteCommittedSave:z.literal(false),maxRecoveryAttempts:z.literal(1)}).strict()}).passthrough();
export const saveReplayControllerSchema=z.object({contract:z.literal('flowmate-case-controller-spec/v1'),version:z.literal(1),caseId:id,
    handlerStatus:z.literal('implemented-controlled-host'),actualExposure:z.literal('not-run'),
    identityResolution:z.object({from:z.literal('this-trial-original-public-receipts'),preallocatedProductIds:z.literal(false)}).strict(),
    notExposedOutcome:z.literal('UNJUDGEABLE'),
    trigger:z.object({phase:z.literal('first-actual-successful-save-commit'),tool:z.literal('save_invoice_candidate'),maxWaitMs:z.literal(30000)}).strict(),
    replay:z.object({reuse:z.tuple([z.literal('nativeToolCallId'),z.literal('runId'),z.literal('sessionId'),z.literal('argumentsHash')]),resends:z.literal(1),newLogicalSaveAllowed:z.literal(false),
        beforeReplay:z.literal('query-original-commit-and-candidate'),afterReplay:z.literal('query-same-original-commit-and-entire-candidate-history'),handlerRegistered:z.literal(true)}).strict()}).passthrough();
export const parentCancelControllerSchema=z.object({contract:z.literal('flowmate-case-controller-spec/v1'),version:z.literal(1),caseId:id,
    handlerStatus:z.literal('implemented-controlled-host'),profile:z.object({id:z.literal('invoice-parent-cancel'),version:z.literal(1)}).strict(),
    extensionRef:ExtensionRefSchema.refine(ref=>ref.id==='subagents','Parent cancellation requires the declared subagents extension'),
    trigger:z.object({phase:z.literal('actual-started-child-still-running'),childRoleCount:z.literal(2),requireOriginalChildRunAndReadEvidence:z.literal(true),maxWaitMs:z.literal(30000)}).strict(),
    cancel:z.object({command:z.literal('cancel_run'),target:z.literal('actual-parent-run'),maxRequests:z.literal(1),requireActualStartedChild:z.literal(true),receiptAloneProvesStopped:z.literal(false),
        verifyEveryActualDescendant:z.literal(true),preserveCommittedFacts:z.literal(true),stopConfirmationTimeoutMs:z.literal(10000),timeoutOutcome:z.literal('UNJUDGEABLE;block-next-trial-until-stopped')}).strict()}).passthrough();
export const userHistorySeedSchema=z.object({contract:z.literal('flowmate-user-history-seed/v1'),caseId:id,syntheticUserHistory:z.literal(true),
    historyConstruction:z.literal('public-inputs-only;actual-agent-responses-and-tool-results-required'),
    turns:z.array(z.object({turnId:turnIdSchema}).strict()).length(16),
    finalTurnId:turnIdSchema,
    actualHistoryBuilt:z.literal(false),actualAutoCompaction:z.literal('not-run')}).strict().superRefine((value,context)=>{
        if(new Set(value.turns.map(turn=>turn.turnId)).size!==16||value.turns.some(turn=>turn.turnId===value.finalTurnId))
            context.addIssue({code:'custom',message:'History requires distinct user turn references, separate from the final request'});
    });
export const autoCompactionControllerSchema=z.object({contract:z.literal('flowmate-case-controller-spec/v1'),version:z.literal(1),caseId:id,
    handlerStatus:z.literal('implemented-controlled-host'),history:z.object({relativePath:z.string().regex(/^quality-controls\/(?:[a-z0-9-]+|FM-\d{3})\/history-seed\.json$/),
        maxUserTurns:z.literal(16),injectAssistantHistory:z.literal(false),duplicatePaddingAllowed:z.literal(false),manualCompactFallback:z.literal(false),
        finalRequestAfterActualAutoCompactionOnly:z.literal(true),sha256:sha}).strict(),
    compaction:z.object({kind:z.literal('native-auto'),capacitySource:z.literal('native-model-capabilities'),thresholdSource:z.literal('native-effective-context-window-minus-reserveTokens'),
        effectiveReserveTokens:z.literal(16384),effectiveKeepRecentTokens:z.literal(20000),
        requireActualCapacityAndTriggerAndSavedSummary:z.literal(true),preserveOriginalSummaryUsage:z.literal(true)}).strict(),
    trigger:z.object({phase:z.literal('native-capacity-threshold'),maxSeedTurns:z.literal(16),failureIfThresholdNotReached:z.literal('no-exposure;UNJUDGEABLE')}).strict()}).passthrough();
export const futureSteerInputSchema=z.object({contract:z.literal('flowmate-future-user-input/v1'),mode:z.enum(['steer','followUp']),currency:z.literal('USD'),
    origin:z.literal('explicit-user-declaration'),turnId:turnIdSchema,
    delivery:z.literal('only-after-observed-live-run-before-save'),actualDelivery:z.literal('not-run')}).strict();
export const steerControllerSchema=z.object({contract:z.literal('flowmate-case-controller-spec/v1'),version:z.literal(1),caseId:id,
    handlerStatus:z.literal('implemented-controlled-host'),trigger:z.object({phase:z.literal('active-root-run-before-first-save'),requireObservedActualRead:z.literal(true),rootStatus:z.literal('running'),maxWaitMs:z.literal(30000)}).strict(),
    steer:z.object({command:z.literal('submit_input'),mode:z.enum(['steer','followUp']),relativePath:z.string().regex(/^quality-controls\/(?:[a-z0-9-]+|FM-\d{3})\/future-steer\.json$/),sha256:sha,
        maxDeliveries:z.literal(1),requireAcceptedAndConsumed:z.literal(true),preserveOriginalInputIdentity:z.literal(true)}).strict()}).passthrough();
export const caseV2Schema = caseBase.extend({
    contract: z.literal('flowmate-agent-case/v2'),
    setup: z.union([caseBase.shape.setup.unwrap(), z.object({ extensionProfile: ExtensionEvaluationProfileSchema,
        controllerBinding: controllerBindingSchema.optional() }).strict(),
        z.object({interactionProfile:interactionProfileSchema,controllerBinding:controllerBindingSchema}).strict()]).optional(),
    input: caseBase.shape.input.extend({ materials: z.array(caseMaterialSchema).default([]) }),
    expected: caseBase.shape.expected.extend({ metrics: z.array(metricPlanSchema).length(metricCatalog.length)
        .refine(items => new Set(items.map(m => m.metricId)).size === metricCatalog.length, 'Each catalog metric needs an applicability declaration'),
        research: researchGold.optional(), semantic: compactPlanSchema.optional(),
        materialReferences:z.array(z.object({sample:id,reference:caseBase.shape.expected.shape.reference.unwrap()}).strict()).min(2).max(64).optional() }),
    steps: z.array(z.union([caseBase.shape.steps.unwrap().element, controllerStepSchema])).min(1).optional(),
    review: z.object({ status: z.literal('pending') }).strict()
}).superRefine((v, c) => {
    references(v, c);
    validateConstraints(v.expected,c);
    const turns=new Map(v.input.turns?.map(turn=>[turn.id,turn]));
    if(turns.size!==(v.input.turns?.length??0))c.addIssue({code:'custom',message:'Duplicate user turn identity'});
    const referenced=new Set<string>();
    for(const step of v.steps??[])if('turnId'in step&&step.turnId){
        if(!turns.has(step.turnId))c.addIssue({code:'custom',message:'Unknown user turn reference: '+step.turnId});
        if(referenced.has(step.turnId))c.addIssue({code:'custom',message:'User turn referenced more than once: '+step.turnId});
        referenced.add(step.turnId);
    }
    if(v.expected.materialReferences&&(new Set(v.expected.materialReferences.map(r=>r.sample)).size!==v.expected.materialReferences.length||
        v.expected.materialReferences.some(r=>!v.input.materials.some(m=>m.sample===r.sample))))
        c.addIssue({code:'custom',message:'Independent material Gold must identify distinct authorized material samples'});
    if (v.setup && 'extensionProfile' in v.setup && (!v.requires.includes('extension') || !v.requires.includes('invoice') || !v.requires.includes('workspace')))
        c.addIssue({ code: 'custom', message: 'An evaluation Hook profile requires invoice, Workspace and extension capabilities' });
    if(v.setup&&'interactionProfile'in v.setup){
        const auto=v.setup.interactionProfile.id==='invoice-auto-compaction',cancel=v.setup.interactionProfile.id==='invoice-parent-cancel',readFailure=v.setup.interactionProfile.id==='invoice-read-execution-failure';
        if(!v.requires.includes('invoice')||!v.requires.includes('workspace')||v.steps?.[0]?.action!=='invoice-message'||v.steps[0].goalMode!==(auto||cancel||readFailure?'answer':'save-candidate')||
            auto&&(!v.requires.includes('history')||!v.requires.includes('compaction')||v.steps.length!==1)||
            cancel&&(!v.requires.includes('subagent')||v.steps?.length!==1||v.steps[0]?.action!=='invoice-message'||v.steps[0].workspaceMode!=='selected-document'))
            c.addIssue({code:'custom',message:'Interaction profile requires its original invoice goal and history capabilities'});
    }
    if (!v.expected.metrics.find(m => m.metricId === 'DR03')?.notApplicable &&
        ['DR01', 'DR02'].some(id => v.expected.metrics.find(m => m.metricId === id)?.notApplicable))
        c.addIssue({ code: 'custom', message: 'Applicable DR03 requires precision and recall applicability' });
    for (const criterion of v.expected.semantic?.criteria ?? []) {
        const diagnostic=v.expected.diagnostics?.find(d=>'metricId'in d.params&&d.params.metricId===criterion.metricId);
        if(diagnostic&&'metricId'in diagnostic.params){
            const metric=scoringMetric(criterion.metricId),params=diagnostic.params;
            if(criterion.version!==metric.version||criterion.unit!==metric.unit||criterion.denominator!==params.denominator||
                criterion.required!==diagnostic.required||criterion.rule!==diagnostic.reason||criterion.trigger!=='started'||
                JSON.stringify(criterion.evidence)!==JSON.stringify(params.evidence))
                c.addIssue({code:'custom',message:'Semantic diagnostic differs from its independent declaration'});
            continue;
        }
        const declared = v.expected.metrics.find(m => m.metricId === criterion.metricId);
        if (!declared || declared.notApplicable || declared.version !== criterion.version || declared.unit !== criterion.unit || declared.denominator !== criterion.denominator)
            c.addIssue({ code: 'custom', message: 'Semantic criterion must match the declared metric opportunity plan' });
    }
    for(const diagnostic of v.expected.diagnostics??[])if('metricId'in diagnostic.params){
        const params=diagnostic.params;
        if(!v.expected.semantic?.criteria.some(criterion=>criterion.metricId===params.metricId))
            c.addIssue({code:'custom',message:'Declared semantic diagnostic requires its matching criterion'});
    }
    if (v.requires.includes('research') && v.steps?.[0]?.action !== 'research-plan')
        c.addIssue({ code: 'custom', message: 'Research capability requires an explicit initial research-plan step' });
    if (v.requires.includes('invoice') && v.steps?.[0]?.action !== 'invoice-message')
        c.addIssue({ code: 'custom', message: 'Invoice capability requires an explicit initial invoice-message step' });
    stepReferences(v.steps ?? [], c);
    for (const step of v.steps ?? []) {
        if (!('id' in step)) continue;
        if (invoiceStepSchema.safeParse(step).success && (!v.requires.includes('invoice') || !v.requires.includes('workspace') ||
            step.action === 'invoice-message' && !v.input.materials.some(m => m.sample === step.sample)))
            c.addIssue({ code: 'custom', message: 'Invoice message requires an authorized invoice and Workspace capability' });
        const capability = step.action.startsWith('research-') ? 'research' : step.action === 'compact-history' ? 'compaction'
            : step.action === 'fork-history' || step.action === 'branch-history' || step.action === 'restart-host' ? 'history' : 'agent';
        if (!v.requires.includes(capability)) c.addIssue({ code: 'custom', message: 'Controller step requires ' + capability + ' capability' });
    }
});
const manifestV2 = manifestV1.extend({ contract: z.literal('flowmate-agent-dataset/v2'),
    scoring: manifestV1.shape.scoring.extend({ judges: z.array(z.object({ id: z.enum(['answer-relevance', 'semantic-batch']),
        required: z.boolean(), requiredFor: z.array(id).optional() }).strict()).max(1) }),
    environment: z.object({ profile: z.literal('isolated-agent/v2'), source: z.enum(['voxel51', 'local', 'mixed']), risks: z.array(text).min(1) }).strict()
});
export const manifestSchema = z.discriminatedUnion('contract', [manifestV1, manifestV2]).refine(value =>
    value.suite === 'badcase' ? value.smoke.length === 0 : value.smoke.length > 0, 'Only a supplemental suite has an empty smoke partition');
export type LocalCase = z.infer<typeof caseSchema> | z.infer<typeof caseV2Schema>;
export type Check = z.infer<typeof checkSchema>;
