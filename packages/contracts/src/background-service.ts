import { z } from 'zod';
import { AppErrorSchema, type Result } from './runtime.ts';

const installationId = z.string().uuid();
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const settingsRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Connection readiness is a read projection; individual work still needs its own authorization checks.
export const BackgroundServiceStateSchema = z.object({
  state: z.enum(['disabled', 'not-installed', 'starting', 'ready', 'blocked', 'stopping', 'offline', 'incompatible']),
  installationId: installationId.nullable(), protocolVersion: version.nullable(), dataVersion: version.nullable(),
  activationOperationId: z.string().uuid().nullable().optional(),
  activationSettingsRevision: settingsRevision.nullable().optional(),
  error: AppErrorSchema.nullable(),
}).strict().refine(value => value.state !== 'ready' || value.installationId !== null && value.protocolVersion !== null
  && value.dataVersion !== null && value.error === null, 'A ready connection needs its verified installation and versions.')
  .refine(value => value.activationSettingsRevision === undefined || value.activationSettingsRevision === null
    || value.activationOperationId !== undefined && value.activationOperationId !== null,
    'The original activation revision belongs to its saved operation.').readonly();
export type BackgroundServiceState = z.infer<typeof BackgroundServiceStateSchema>;
export const BackgroundServiceConnectRequestSchema = z.object({ installationId }).strict();
export type BackgroundServiceConnectRequest = z.infer<typeof BackgroundServiceConnectRequestSchema>;
export const BackgroundServiceDisconnectRequestSchema = z.object({ installationId }).strict();
export type BackgroundServiceDisconnectRequest = z.infer<typeof BackgroundServiceDisconnectRequestSchema>;

export const BackgroundServicePrepareRequestSchema = z.object({}).strict();
export type BackgroundServicePrepareRequest = z.infer<typeof BackgroundServicePrepareRequestSchema>;
export const BackgroundServicePreparationSchema = z.object({ installationId, serviceName: z.string().min(1).max(128),
  configurationPublished: z.literal(true) }).strict().refine(value => value.serviceName === 'FlowmateRuntime' + value.installationId.replaceAll('-', ''),
  'Preparation belongs to the original installation.').readonly();
export type BackgroundServicePreparation = z.infer<typeof BackgroundServicePreparationSchema>;
export const BackgroundServiceEnableRequestSchema = z.object({ installationId, operationId: z.string().uuid(),
  expectedSettingsRevision: settingsRevision }).strict();
export type BackgroundServiceEnableRequest = z.infer<typeof BackgroundServiceEnableRequestSchema>;
export const BackgroundServiceActivationQuerySchema = z.object({ installationId, operationId: z.string().uuid() }).strict();
export type BackgroundServiceActivationQuery = z.infer<typeof BackgroundServiceActivationQuerySchema>;
// Saved handoff facts and current connection observations are independent, not another task state machine.
export const BackgroundServiceActivationViewSchema = z.object({ version: z.literal(1), installationId, operationId: z.string().uuid(),
  expectedSettingsRevision: settingsRevision.nullable(),
  accepted: z.boolean(), backupId: z.string().uuid().nullable(), credentialsPublished: z.boolean().nullable(), enabled: z.boolean(),
  connected: z.boolean(), active: z.boolean().nullable(), error: AppErrorSchema.nullable() }).strict()
  .refine(value => value.active !== true || value.enabled && value.connected, 'Active scheduling requires an observed enabled connection.').readonly();
export type BackgroundServiceActivationView = z.infer<typeof BackgroundServiceActivationViewSchema>;

export interface BackgroundServiceApi {
  getServiceState(): Promise<Result<BackgroundServiceState>>;
  connect(input: BackgroundServiceConnectRequest): Promise<Result<BackgroundServiceState>>;
  disconnect(input: BackgroundServiceDisconnectRequest): Promise<Result<BackgroundServiceState>>;
  prepare(input: BackgroundServicePrepareRequest): Promise<Result<BackgroundServicePreparation>>;
  enable(input: BackgroundServiceEnableRequest): Promise<Result<BackgroundServiceActivationView>>;
  queryActivation(input: BackgroundServiceActivationQuery): Promise<Result<BackgroundServiceActivationView>>;
}
