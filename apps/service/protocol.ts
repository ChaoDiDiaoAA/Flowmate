import { z } from 'zod';
import { AppErrorSchema, type AppError } from '@flowmate/contracts';
import { ServiceCredentialMigrationRequestSchema, ServiceCredentialOperationQuerySchema, ServiceCredentialSettingsRequestSchema,
  ServiceCredentialStatusSchema, ServiceCredentialOperationReceiptSchema } from '../../packages/core/src/configuration/service-credentials.ts';

export const SERVICE_PROTOCOL_VERSION = 1;
export const SERVICE_DATA_VERSION = 21;
const privateErrorCodes = new Set(['host_protocol_invalid', 'host_closing', 'service_control_failed', 'service_installation_invalid',
  'service_standby', 'service_activation_pending', 'service_activation_unconfirmed', 'service_connection_unknown',
  'foreground_stop_unconfirmed', 'config_revision_conflict', 'config_settings_invalid', 'credential_model_missing',
  'evaluation_settings_separate', 'operation_result_unknown', 'service_credential_models_changed', 'service_credential_not_prepared',
  'service_credential_operation_conflict', 'service_credential_operation_missing', 'service_credential_operation_unavailable',
  'service_credential_publication_pending', 'service_credential_request_invalid', 'service_credential_status_unavailable']);
const safePrivateError = (error: AppError) => ({ code: privateErrorCodes.has(error.code) ? error.code : 'service_control_failed',
  category: error.category, retryable: error.retryable,
  message: 'The service operation could not be confirmed. Query the original operation before retrying.' });
const privateErrorSchema = AppErrorSchema.transform(safePrivateError);
export function servicePipeName(installationId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(installationId))
    throw Error('pipe_installation_invalid');
  return `\\\\.\\pipe\\Flowmate-${installationId.toLowerCase()}`;
}
const identity = { version: z.literal(1), installationId: z.string().uuid(), releaseId: z.string().uuid(),
  protocolVersion: z.literal(SERVICE_PROTOCOL_VERSION), dataVersion: z.literal(SERVICE_DATA_VERSION) };
export const ServiceConnectSchema = z.object({ ...identity, type: z.literal('service_connect') }).strict();
export const ServiceReadySchema = z.object({ ...identity, type: z.literal('service_ready'), connectionId: z.string().uuid() }).strict();
export const ServiceFailureSchema = z.object({ version: z.literal(1), type: z.literal('service_error'),
  result: z.object({ ok: z.literal(false), error: AppErrorSchema }).strict() }).strict();
export type ServiceConnect = z.infer<typeof ServiceConnectSchema>;
export type ServiceReady = z.infer<typeof ServiceReadySchema>;
export type ServiceFailure = z.infer<typeof ServiceFailureSchema>;
export type ServiceHandshake = ServiceReady | ServiceFailure;
const handshake = z.discriminatedUnion('type', [ServiceReadySchema, ServiceFailureSchema]);
export const ServicePrepareDisconnectSchema = z.object({ version: z.literal(1), type: z.literal('service_prepare_disconnect'),
  requestId: z.string().uuid() }).strict();
export type ServicePrepareDisconnect = z.infer<typeof ServicePrepareDisconnectSchema>;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const ForegroundReferenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('run'), runId: id, sessionId: id.nullable() }).strict(),
  z.object({ kind: z.literal('compaction'), sessionId: id, operationId: z.string().uuid() }).strict(),
]);
export type ForegroundReference = z.infer<typeof ForegroundReferenceSchema>;
export const ForegroundDisconnectReportSchema = z.object({ connectionId: z.string().uuid(), stopped: z.boolean(),
  pendingAdmissions: z.array(z.string().min(1).max(128)).max(4096), pending: z.array(ForegroundReferenceSchema).max(4096),
  errors: z.array(privateErrorSchema).max(16),
}).strict().refine(value => value.stopped === (value.pendingAdmissions.length === 0 && value.pending.length === 0),
  'Stopping requires original foreground admission and stop facts.');
export type ForegroundDisconnectReport = z.infer<typeof ForegroundDisconnectReportSchema>;
export const ForegroundDisconnectResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data: ForegroundDisconnectReportSchema }).strict(),
  z.object({ ok: z.literal(false), error: privateErrorSchema }).strict(),
]);
const privateHeader = { version: z.literal(1), requestId: z.string().uuid() };
export const ServicePrepareActivationRequestSchema = ServiceCredentialOperationQuerySchema.extend({
  expectedSettingsRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type ServicePrepareActivationRequest = z.infer<typeof ServicePrepareActivationRequestSchema>;
export const ServiceActivationSchema = z.object({ ...privateHeader, type: z.literal('service_activate'),
  input: ServiceCredentialOperationQuerySchema }).strict();
export const ServicePrivateCommandSchema = z.discriminatedUnion('type', [
  ServicePrepareDisconnectSchema,
  z.object({ ...privateHeader, type: z.literal('service_query_disconnect'), input: z.object({ connectionId: z.string().uuid() }).strict() }).strict(),
  z.object({ ...privateHeader, type: z.literal('service_credentials_status') }).strict(),
  z.object({ ...privateHeader, type: z.literal('service_credentials_prepare'), input: ServiceCredentialMigrationRequestSchema }).strict(),
  z.object({ ...privateHeader, type: z.literal('service_credentials_commit'), input: ServiceCredentialOperationQuerySchema }).strict(),
  z.object({ ...privateHeader, type: z.literal('service_credentials_query_operation'), input: ServiceCredentialOperationQuerySchema }).strict(),
  z.object({ ...privateHeader, type: z.literal('service_settings_save'), input: ServiceCredentialSettingsRequestSchema }).strict(),
  z.object({ ...privateHeader, type: z.literal('service_prepare_activation'), input: ServicePrepareActivationRequestSchema }).strict(),
  z.object({ ...privateHeader, type: z.literal('service_query_activation'), input: ServiceCredentialOperationQuerySchema }).strict(),
  ServiceActivationSchema,
]);
export type ServicePrivateCommand = z.infer<typeof ServicePrivateCommandSchema>;
export type ServicePrivateCommandType = ServicePrivateCommand['type'];
const serviceResult = <T extends z.ZodTypeAny>(data: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), data }).strict(), z.object({ ok: z.literal(false), error: privateErrorSchema }).strict(),
]);
const privateReceipt = ServiceCredentialOperationReceiptSchema.transform(value => ({ ...value,
  error: value.error === null ? null : safePrivateError(value.error) }));
export const ServiceActivationResultSchema = serviceResult(z.object({ installationId: z.string().uuid(),
  operationId: z.string().uuid(), active: z.literal(true) }).strict());
export const ServicePrepareActivationResultSchema = serviceResult(z.object({ installationId: z.string().uuid(),
  operationId: z.string().uuid(), settingsRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), ready: z.literal(true) }).strict());
export const ServiceQueryActivationResultSchema = serviceResult(z.object({ installationId: z.string().uuid(),
  operationId: z.string().uuid(), active: z.boolean() }).strict());
export const ServicePrivateResultSchemas = {
  service_prepare_disconnect: ForegroundDisconnectResultSchema,
  service_query_disconnect: ForegroundDisconnectResultSchema,
  service_credentials_status: serviceResult(ServiceCredentialStatusSchema),
  service_credentials_prepare: serviceResult(privateReceipt),
  service_credentials_commit: serviceResult(privateReceipt),
  service_credentials_query_operation: serviceResult(privateReceipt.nullable()),
  service_settings_save: serviceResult(privateReceipt),
  service_activate: ServiceActivationResultSchema,
  service_prepare_activation: ServicePrepareActivationResultSchema,
  service_query_activation: ServiceQueryActivationResultSchema,
} as const;

export function parseServiceConnect(value: unknown): ServiceConnect | null {
  const result = ServiceConnectSchema.safeParse(value);
  return result.success ? result.data : null;
}
export function parseServiceHandshake(value: unknown): ServiceHandshake | null {
  const result = handshake.safeParse(value);
  return result.success ? result.data : null;
}
export function parseForegroundDisconnectResult(value: unknown): z.infer<typeof ForegroundDisconnectResultSchema> | null {
  const result = ForegroundDisconnectResultSchema.safeParse(value);
  return result.success ? result.data : null;
}
export function parseServicePrivateCommand(value: unknown): ServicePrivateCommand | null {
  const result = ServicePrivateCommandSchema.safeParse(value);
  return result.success ? result.data : null;
}
export function parseServicePrivateResult(type: ServicePrivateCommandType, value: unknown) {
  const result = ServicePrivateResultSchemas[type].safeParse(value);
  return result.success ? result.data : null;
}
