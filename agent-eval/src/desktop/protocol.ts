import { z } from 'zod';
import { AppErrorSchema, EvaluationConnectionSchema, EvaluationConfigurationSnapshotSchema, EvaluationEventSchema, EvaluationIdSchema,
  evaluationRequests, evaluationResponses, type Result } from '@flowmate/contracts';
import { langfuseConnectionSchema } from '../configuration.ts';
import { EvaluationWorkflowRequestSchema, EvaluationWorkflowResultSchema } from '../../../packages/contracts/src/evaluation-workflow.ts';

export const EVALUATION_FRAME_LIMIT = 4 * 1024 * 1024;
const envelope = { version: z.literal(1), sessionId: EvaluationIdSchema, messageId: EvaluationIdSchema };
const commandSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('evaluation_workflow'), input: EvaluationWorkflowRequestSchema,
    context: z.object({ agentCredentials: z.array(z.object({ connection: EvaluationConnectionSchema,
      apiKey: z.string().trim().min(1).max(4096) }).strict()).max(11) }).strict().optional() }).strict(),
  z.object({ ...envelope, type: z.literal('query_evaluation_catalog'), input: evaluationRequests.query_evaluation_catalog }).strict(),
  z.object({ ...envelope, type: z.literal('add_evaluation_feedback'), input: evaluationRequests.add_evaluation_feedback }).strict(),
  z.object({ ...envelope, type: z.literal('query_evaluation_feedback'), input: evaluationRequests.query_evaluation_feedback }).strict(),
  z.object({ ...envelope, type: z.literal('export_evaluation'), input: evaluationRequests.export_evaluation,
    connection: langfuseConnectionSchema }).strict(),
  z.object({ ...envelope, type: z.literal('preview_evaluation'), input: evaluationRequests.preview_evaluation,
    settings: EvaluationConfigurationSnapshotSchema }).strict(),
  z.object({ ...envelope, type: z.literal('start_evaluation'), input: evaluationRequests.start_evaluation,
    context: z.object({ batchId: EvaluationIdSchema, settings: EvaluationConfigurationSnapshotSchema,
      credentials: z.object({ agent: z.string().trim().min(1).max(4096), judge: z.string().trim().min(1).max(4096).nullable() }).strict(),
    }).strict() }).strict(),
  z.object({ ...envelope, type: z.literal('query_evaluation_control'), input: evaluationRequests.query_evaluation_control }).strict(),
  z.object({ ...envelope, type: z.literal('cancel_evaluation'), input: evaluationRequests.cancel_evaluation }).strict(),
  z.object({ ...envelope, type: z.literal('list_evaluation_executions'), input: evaluationRequests.list_evaluation_executions }).strict(),
  z.object({ ...envelope, type: z.literal('query_evaluation_result'), input: evaluationRequests.query_evaluation_result }).strict(),
  z.object({ ...envelope, type: z.literal('compare_evaluation'), input: evaluationRequests.compare_evaluation }).strict(),
  z.object({ ...envelope, type: z.literal('shutdown'), input: z.object({}).strict() }).strict(),
]);
export type EvaluationWorkerCommand = z.infer<typeof commandSchema>;
export type EvaluationWorkerOperation = EvaluationWorkerCommand['type'];
export const evaluationWorkerResponses = { ...evaluationResponses,
  evaluation_workflow: EvaluationWorkflowResultSchema,
  shutdown: z.object({ closed: z.boolean(), stopped: z.boolean() }).strict() } as const;
export type EvaluationWorkerData<K extends EvaluationWorkerOperation> = z.infer<(typeof evaluationWorkerResponses)[K]>;
export type EvaluationWorkerReply = { [K in EvaluationWorkerOperation]: { version: 1; type: 'response'; sessionId: string;
  messageId: string; sequence: number; operation: K; result: Result<EvaluationWorkerData<K>> } }[EvaluationWorkerOperation];
const outputSchema = z.discriminatedUnion('type', [
  z.object({ version: z.literal(1), type: z.literal('ready'), sessionId: EvaluationIdSchema }).strict(),
  z.object({ version: z.literal(1), type: z.literal('event'), sessionId: EvaluationIdSchema, event: EvaluationEventSchema }).strict(),
  z.object({ ...envelope, type: z.literal('response'), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), operation: z.enum(['preview_evaluation', 'start_evaluation',
    'query_evaluation_control', 'cancel_evaluation', 'list_evaluation_executions', 'query_evaluation_result', 'compare_evaluation',
    'query_evaluation_catalog', 'add_evaluation_feedback', 'query_evaluation_feedback', 'export_evaluation', 'evaluation_workflow', 'shutdown']), result: z.unknown() }).strict(),
  z.object({ version: z.literal(1), type: z.literal('protocol-error'), sessionId: EvaluationIdSchema, error: AppErrorSchema }).strict(),
]);
export type EvaluationWorkerOutput = Exclude<z.infer<typeof outputSchema>, { type: 'response' }> | EvaluationWorkerReply;
export function parseEvaluationWorkerCommand(input: unknown): EvaluationWorkerCommand | null {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success || parsed.data.type === 'evaluation_workflow' && parsed.data.context && parsed.data.input.action !== 'experiment.run') return null;
  return parsed.data;
}
export function parseEvaluationWorkerOutput(input: unknown): EvaluationWorkerOutput | null {
  const parsed = outputSchema.safeParse(input); if (!parsed.success) return null;
  const value = parsed.data;
  if (value.type === 'event' && value.event.sessionId !== value.sessionId) return null;
  if (value.type !== 'response') return value;
  const result = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: evaluationWorkerResponses[value.operation] }).strict(),
    z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]).safeParse(value.result);
  if (!result.success || result.data.ok && 'sessionId' in result.data.data && result.data.data.sessionId !== value.sessionId) return null;
  return { ...value, result: result.data } as EvaluationWorkerReply;
}
