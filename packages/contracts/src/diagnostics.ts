import { z } from 'zod';
import { AppErrorSchema, type Result } from './runtime.ts';

const diagnosticCode = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const diagnosticCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const HostDiagnosticCodeSchema = z.enum(['installation_runtime_invalid', 'installation_dependency_missing',
  'host_application_start_failed', 'host_start_failed', 'host_start_timeout', 'host_spawn_failed', 'host_exited',
  'host_write_failed', 'host_protocol_invalid', 'host_close_unconfirmed', 'runtime_already_owned', 'runtime_lock_failed',
  'runtime_lock_release_failed', 'storage_schema_unsupported', 'storage_open_failed', 'config_settings_invalid',
  'config_settings_read_failed', 'config_settings_write_failed', 'maintenance_store_incompatible', 'maintenance_backup_failed',
  'maintenance_reference_missing', 'maintenance_restore_failed', 'maintenance_release_record_failed']);
const diagnosticStderr = z.string().max(16384).refine(value => !value || value.endsWith('\n') && value.trimEnd().split('\n').every(line => {
  const match = /^\[Flowmate\] ([a-z][a-z0-9_]{0,127})$/.exec(line);
  return match !== null && HostDiagnosticCodeSchema.safeParse(match[1]).success;
}));
export const DiagnosticLogEntrySchema = z.object({
  at: z.string().datetime(), level: z.enum(['info', 'warn', 'error']), component: diagnosticCode,
  event: diagnosticCode, code: diagnosticCode.optional(), runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type DiagnosticLogEntry = z.infer<typeof DiagnosticLogEntrySchema>;
export const DiagnosticLogSnapshotSchema = z.object({ entries: z.array(DiagnosticLogEntrySchema).max(256), dropped: diagnosticCount }).strict();
export const DiagnosticsRuntimeSchema = z.object({ bunVersion: diagnosticCode.nullable(), sdkVersion: diagnosticCode,
  platform: diagnosticCode, arch: diagnosticCode }).strict();
export const HostDiagnosticsSchema = z.object({ version: z.literal(1), productVersion: diagnosticCode,
  ...DiagnosticLogSnapshotSchema.shape, runtime: DiagnosticsRuntimeSchema }).strict();
export const HostDiagnosticsResultSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: HostDiagnosticsSchema }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]);
export const DiagnosticsSnapshotSchema = z.object({ version: z.literal(1), collectedAt: z.string().datetime(), productVersion: diagnosticCode,
  main: DiagnosticLogSnapshotSchema,
  host: z.object({ availability: z.enum(['available', 'timeout', 'source-unavailable']), entries: z.array(DiagnosticLogEntrySchema).max(256),
    dropped: diagnosticCount.nullable(), stderrTail: diagnosticStderr,
    stderrTruncated: z.boolean() }).strict(),
  runtime: DiagnosticsRuntimeSchema,
  configuration: z.object({ modelId: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/).nullable(),
    credential: z.enum(['missing', 'configured', 'unavailable']) }).strict(),
  gaps: z.array(diagnosticCode).max(32),
}).strict();
export type DiagnosticsSnapshot = z.infer<typeof DiagnosticsSnapshotSchema>;
export const DiagnosticsResultSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: DiagnosticsSnapshotSchema }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]);
export const DiagnosticsExportResultSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true),
  data: z.object({ outcome: z.enum(['cancelled', 'saved']) }).strict() }).strict(), z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]);
export interface DiagnosticsDesktopApi {
  queryDiagnostics(): Promise<Result<DiagnosticsSnapshot>>;
  exportDiagnostics(): Promise<Result<{ outcome: 'cancelled' | 'saved' }>>;
}

export type PromptTraceEvent =
  | 'model_request'
  | 'request_budget'
  | 'request_dispatched'
  | 'response_started'
  | 'text_delta'
  | 'native_terminal'
  | `agent:${import('./ports.ts').AgentNativeEventName}`;

export type PromptTraceReference = {
  purpose?: 'answer' | 'summary-history' | 'summary-turn-prefix';
  answerRequestSequence?: number | null;
  operationId?: string;
  runId: number;
  sessionId: number;
  nativeSessionId: string;
  callSequence: number;
};

export type PromptTraceEntry = {
  at: string;
  event: PromptTraceEvent;
  summary: string;
  truncated: boolean;
};

export type PromptTraceCall = PromptTraceReference & {
  state: 'active' | 'ended';
  entries: PromptTraceEntry[];
  droppedEntries: number;
};

export type PromptTraceAvailability =
  | 'available'
  | 'not-started'
  | 'evicted'
  | 'process-exited'
  | 'source-unavailable'
  | 'not-collected';

export type PromptTraceResult = {
  availability: PromptTraceAvailability;
  calls: PromptTraceCall[];
  droppedCalls: number | null;
};

export interface PromptTraceBuffer {
  begin(reference: PromptTraceReference): void;
  append(reference: PromptTraceReference, entry: PromptTraceEntry): void;
  end(reference: PromptTraceReference): void;
  clearSession(sessionId: number): void;
  query(runId: number, callSequence?: number): PromptTraceResult;
}
