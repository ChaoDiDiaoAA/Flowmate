import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AppErrorSchema, appError, fail, ok, type AppError, type Result, type ProductSettings,
  type BackgroundServicePreparation, type BackgroundServiceEnableRequest, type BackgroundServiceActivationQuery,
  type BackgroundServiceActivationView } from '@flowmate/contracts';
import { beginServiceActivation, publishServiceEnabled, serviceActivationBackupDirectory,
  readServiceActivationBackup } from '../../../packages/shared/src/service-activation.ts';
import { resolveRuntimeLayout, type RuntimeLayout } from '../../../packages/shared/src/runtime-layout.ts';
import { ServiceInstallationSchema, type ServiceInstallation } from '../../../packages/shared/src/service-layout.ts';
import type { ServiceClient } from './service-client.ts';

const refusal = (code: string, message: string) => fail(appError(code, 'runtime', message, true));
const resultSchema = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]);
const releaseSchema = z.union([z.null(), z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), error: AppErrorSchema }).strict()]);
const backupSchema = z.object({ directory: z.string(), backupId: z.string().uuid(), schemaVersion: z.number().nullable(),
  settingsVersion: z.number().nullable(), fileCount: z.number().int().positive(), gaps: z.array(z.string()), gapCount: z.number().int().nonnegative() }).strict();
const startedSchema = z.object({ installationId: z.string().uuid(), serviceName: z.string(), action: z.literal('start'),
  wrapperExitCode: z.literal(0), observedState: z.enum(['not-installed', 'stopped', 'not-stopped']),
  controllerReleased: z.boolean().nullable(), productReadyVerified: z.literal(false), productStopVerified: z.literal(false) }).strict();

// These fixed installed entries get only OS environment. No credential or inherited provider variables cross this boundary.
async function runInstalled(layout: RuntimeLayout, args: string[], operation?: string): Promise<Result<unknown>> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  try {
    const output = await new Promise<{ text: string; exit: number | null }>((resolve, reject) => {
      const child = spawn(layout.bunExecutable, ['--no-env-file', ...args], { cwd: layout.runtimeRoot, env, windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'] });
      let text = '', size = 0;
      const timer = setTimeout(() => { child.kill(); reject(Error('timeout')); }, 60_000);
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size <= 65_536) text += chunk.toString('utf8');
        else { child.kill(); reject(Error('output_limit')); } });
      child.once('error', cause => { clearTimeout(timer); reject(cause); });
      child.once('close', exit => { clearTimeout(timer); resolve({ text, exit }); });
    });
    const envelope = (operation ? z.object({ version: z.literal(1), operation: z.literal(operation), result: resultSchema,
      leaseRelease: releaseSchema }).strict() : z.object({ version: z.literal(1), result: resultSchema }).strict()).safeParse(JSON.parse(output.text));
    if (!envelope.success) throw Error('invalid_result');
    if (!envelope.data.result.ok) return envelope.data.result;
    if (operation) {
      const released = releaseSchema.parse(Reflect.get(envelope.data, 'leaseRelease'));
      if (released && !released.ok) return released;
    }
    return output.exit === 0 ? ok(envelope.data.result.data) : refusal('service_activation_result_unknown', 'The original service preparation result is unknown. Query the original activation before continuing.');
  } catch { return refusal('service_activation_result_unknown', 'The original service preparation result is unknown. Existing files and operation IDs were retained.'); }
}

type ActivationOptions = {
  client: ServiceClient;
  dataRoot(): string;
  runtimeLayout(): RuntimeLayout | null;
  installation(): Result<ServiceInstallation | null>;
  readSettings(): Promise<Result<ProductSettings>>;
  readCredential(reference: string): Promise<Result<string | null>>;
  confirmForm(): Promise<boolean>;
  closing(): boolean;
  canBegin(): boolean;
  pending(installation: ServiceInstallation): void;
  closeLegacy(): Promise<Result<void>>;
  active(installation: ServiceInstallation): Promise<Result<void>>;
};

export function createServiceActivation(options: ActivationOptions) {
  let busy = false;
  function layout(installation: ServiceInstallation | null): Result<RuntimeLayout> {
    if (!installation) {
      const original = options.runtimeLayout();
      return original?.mode === 'installed' ? ok(original) : refusal('service_runtime_unavailable', 'Prepare the background service from an installed Flowmate release.');
    }
    return resolveRuntimeLayout({ isPackaged: true, appPath: join(dirname(installation.runtimeRoot), 'app.asar'),
      resourcesPath: dirname(installation.runtimeRoot), userDataRoot: options.dataRoot() });
  }
  function original(input: BackgroundServiceActivationQuery): Result<ServiceInstallation> {
    const saved = options.installation(); if (!saved.ok) return saved;
    if (!saved.data || saved.data.installationId !== input.installationId) return refusal('service_installation_invalid', 'The original service installation changed.');
    if (saved.data.activationOperationId !== null && saved.data.activationOperationId !== undefined && saved.data.activationOperationId !== input.operationId)
      return refusal('service_activation_operation_conflict', 'Continue the original service activation operation.');
    return ok(saved.data);
  }
  async function query(input: BackgroundServiceActivationQuery): Promise<Result<BackgroundServiceActivationView>> {
    const saved = original(input); if (!saved.ok) return saved;
    const installation = saved.data, accepted = installation.activationOperationId === input.operationId;
    const identity = { installationId: input.installationId, operationId: input.operationId };
    let backupId: string | null = null, credentialsPublished: boolean | null = null, active: boolean | null = null, error: AppError | null = null;
    if (accepted) {
      const backup = await readServiceActivationBackup({ installation, operationId: input.operationId });
      if (backup.ok) backupId = backup.data?.id ?? null; else error = backup.error;
      if (options.client.isConnected) {
        const receipt = await options.client.queryCredentialOperation(identity);
        if (!receipt.ok) error ??= receipt.error;
        else if (receipt.data) {
          if (receipt.data.kind !== 'migration') error ??= appError('service_activation_operation_conflict', 'runtime', 'The original operation belongs to another service action.');
          else if (receipt.data.phase === 'committed') credentialsPublished = true;
          else if (receipt.data.phase === 'failed' && receipt.data.error?.code !== 'operation_result_unknown') {
            credentialsPublished = receipt.data.error ? false : null; error ??= receipt.data.error;
          } else error ??= receipt.data.error;
        }
        const observation = await options.client.queryActivation(identity);
        if (observation.ok) active = observation.data.active; else error ??= observation.error;
      }
    }
    return ok({ version: 1, installationId: input.installationId, operationId: input.operationId,
      expectedSettingsRevision: accepted ? installation.activationSettingsRevision ?? null : null,
      accepted, backupId, credentialsPublished, enabled: installation.enabled === true, connected: options.client.isConnected,
      active, error });
  }
  async function prepare(): Promise<Result<BackgroundServicePreparation>> {
    if (busy || options.closing()) return refusal('service_activation_busy', 'The original service handoff is still in progress.');
    busy = true;
    try {
      const saved = options.installation(); if (!saved.ok) return saved;
      const runtime = layout(saved.data); if (!runtime.ok) return runtime;
      const prepared = await runInstalled(runtime.data, [runtime.data.maintenanceEntry, 'prepare-service', '--user-data-root', options.dataRoot()], 'prepare-service');
      if (!prepared.ok) return prepared;
      const parsed = ServiceInstallationSchema.safeParse(prepared.data);
      const current = options.installation();
      if (!parsed.success || !current.ok || !current.data || current.data.installationId !== parsed.data.installationId
        || parsed.data.dataRoot !== options.dataRoot() || parsed.data.runtimeRoot !== runtime.data.runtimeRoot)
        return refusal('service_activation_result_unknown', 'The prepared service configuration could not be confirmed.');
      return ok({ installationId: parsed.data.installationId, serviceName: parsed.data.serviceName, configurationPublished: true });
    } finally { busy = false; }
  }
  async function enable(input: BackgroundServiceEnableRequest): Promise<Result<BackgroundServiceActivationView>> {
    if (busy || options.closing() || !options.canBegin()) return refusal('service_activation_busy', 'Finish the original foreground or evaluation operation before enabling the service.');
    busy = true;
    const identity = { installationId: input.installationId, operationId: input.operationId };
    const finish = async (error?: AppError): Promise<Result<BackgroundServiceActivationView>> => {
      const view = await query(input); return view.ok && error ? ok({ ...view.data, error }) : view;
    };
    try {
      const saved = original(input); if (!saved.ok) return saved;
      if (saved.data.activationOperationId === input.operationId && saved.data.activationSettingsRevision !== input.expectedSettingsRevision)
        return refusal('service_activation_operation_conflict', 'The original activation settings revision changed.');
      if (saved.data.enabled === true && options.client.isConnected) {
        const observed = await options.client.queryActivation(identity);
        if (observed.ok && observed.data.active) {
          const attached = await options.active(saved.data); return finish(attached.ok ? undefined : attached.error);
        }
      }
      if (!await options.confirmForm()) return refusal('state_conflict', 'The original invoice draft is retained.');
      if (options.closing()) return refusal('runtime_closing', 'The desktop is closing.');
      if (saved.data.activationOperationId === null || saved.data.activationOperationId === undefined) {
        const settings = await options.readSettings(); if (!settings.ok) return settings;
        if (settings.data.revision !== input.expectedSettingsRevision) return refusal('config_revision_conflict', 'Refresh the saved model configuration before enabling the service.');
      }
      const begun = await beginServiceActivation({ installation: saved.data, operationId: input.operationId,
        expectedSettingsRevision: input.expectedSettingsRevision });
      if (!begun.ok) return begun;
      let installation = begun.data;
      options.pending(installation);
      const stopped = await options.closeLegacy(); if (!stopped.ok) return finish(stopped.error);
      if (options.closing()) return finish(appError('runtime_closing', 'runtime', 'The desktop is closing.'));
      const runtime = layout(installation); if (!runtime.ok) return finish(runtime.error);
      const directory = serviceActivationBackupDirectory(installation, input.operationId); if (!directory.ok) return finish(directory.error);
      const backup = await readServiceActivationBackup({ installation, operationId: input.operationId }); if (!backup.ok) return finish(backup.error);
      if (!backup.data) {
        // Only the existing fixed backups parent is created; the offline producer owns the snapshot directory.
        await mkdir(dirname(directory.data), { recursive: true });
        const result = await runInstalled(runtime.data, [runtime.data.maintenanceEntry, 'backup', '--user-data-root', options.dataRoot(), '--destination', directory.data], 'backup');
        if (!result.ok) return finish(result.error);
        const parsed = backupSchema.safeParse(result.data);
        if (!parsed.success || parsed.data.directory !== directory.data) return finish(appError('service_activation_backup_invalid', 'storage', 'The original backup response could not be confirmed.'));
      }
      const verified = await runInstalled(runtime.data, [runtime.data.maintenanceEntry, 'verify-backup', '--user-data-root', options.dataRoot(), '--backup', directory.data], 'verify-backup');
      if (!verified.ok) return finish(verified.error);
      const snapshot = backupSchema.safeParse(verified.data);
      if (!snapshot.success || snapshot.data.directory !== directory.data || backup.data && snapshot.data.backupId !== backup.data.id)
        return finish(appError('service_activation_backup_invalid', 'storage', 'The original backup snapshot could not be confirmed.'));
      if (options.closing()) return finish(appError('runtime_closing', 'runtime', 'The desktop is closing.'));
      if (!options.client.isConnected) {
        const connected = await options.client.connect(installation, 1500);
        if (!connected.ok) {
          const started = await runInstalled(runtime.data, [join(runtime.data.runtimeRoot, 'apps/service-manager.js'), 'start',
            '--installation-file', join(options.dataRoot(), 'service-installation.json')]);
          if (!started.ok) return finish(started.error);
          const parsed = startedSchema.safeParse(started.data);
          if (!parsed.success || parsed.data.installationId !== input.installationId || parsed.data.serviceName !== installation.serviceName)
            return finish(appError('service_activation_result_unknown', 'runtime', 'The original service start could not be confirmed.'));
          const retried = await options.client.connect(installation); if (!retried.ok) return finish(retried.error);
        }
      }
      if (options.closing()) return finish(appError('runtime_closing', 'runtime', 'The desktop is closing.'));
      const receipt = await options.client.queryCredentialOperation(identity); if (!receipt.ok) return finish(receipt.error);
      if (receipt.data && (receipt.data.kind !== 'migration' || receipt.data.expectedSettingsRevision !== input.expectedSettingsRevision))
        return finish(appError('service_activation_operation_conflict', 'runtime', 'The original credential operation does not match the activation.'));
      if (receipt.data?.phase === 'failed') return finish(receipt.data.error ?? appError('operation_result_unknown', 'runtime', 'The original credential migration is unknown.'));
      if (!receipt.data || receipt.data.phase === 'pending') {
        const settings = await options.readSettings(); if (!settings.ok) return finish(settings.error);
        if (settings.data.revision !== input.expectedSettingsRevision) return finish(appError('config_revision_conflict', 'input', 'The original activation settings revision changed.'));
        const credentials: Array<{ modelId: string; credentialRef: string; value: string | null }> = [];
        for (const model of settings.data.models) {
          const value = await options.readCredential(model.credentialRef); if (!value.ok) return finish(value.error);
          credentials.push({ modelId: model.id, credentialRef: model.credentialRef, value: value.data });
        }
        const prepared = await options.client.prepareCredentialMigration({ ...input, credentials }); if (!prepared.ok) return finish(prepared.error);
        if (prepared.data.phase !== 'prepared' && prepared.data.phase !== 'committed') return finish(prepared.data.error
          ?? appError('operation_result_unknown', 'runtime', 'The original credential preparation is awaiting confirmation.'));
      }
      if (receipt.data?.phase !== 'committed') {
        const committed = await options.client.commitCredentialMigration(identity); if (!committed.ok) return finish(committed.error);
        if (committed.data.phase !== 'committed') return finish(committed.data.error
          ?? appError('operation_result_unknown', 'runtime', 'The original credential publication is awaiting confirmation.'));
      }
      if (installation.enabled !== true) {
        const ready = await options.client.prepareActivation(input); if (!ready.ok) return finish(ready.error);
        if (options.closing()) return finish(appError('runtime_closing', 'runtime', 'The desktop is closing.'));
        const published = await publishServiceEnabled({ installation, operationId: input.operationId }); if (!published.ok) return finish(published.error);
        installation = published.data; options.pending(installation);
      }
      const activated = await options.client.activateService(identity); if (!activated.ok) return finish(activated.error);
      const attached = await options.active(installation); return finish(attached.ok ? undefined : attached.error);
    } catch { return finish(appError('service_activation_result_unknown', 'runtime', 'The original activation result is unknown. Continue its saved operation ID.', true)); }
    finally { busy = false; }
  }
  return { prepare, enable, query, get busy() { return busy; } };
}
