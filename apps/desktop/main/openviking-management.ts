import { dialog, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { open, lstat, link, rm } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok } from '@flowmate/contracts';
import { createCredentialStore } from '../../../packages/shared/src/secure-credential-store.ts';
import { systemSecureStorage } from './secure-storage.ts';
import {
  isOpenVikingManagementWrite, OpenVikingManagementConnectionSchema, OpenVikingManagementRequestSchema,
  OpenVikingManagementReceiptSchema, OpenVikingManagementReceiptActionSchema, OpenVikingManagementTaskIdSchema,
  type OpenVikingManagementConnection, type OpenVikingManagementView, type OpenVikingManagementReceipt,
} from '../../../packages/contracts/src/openviking-management.ts';
import { readManagementTaskStatus, runOpenVikingManagement, verifyManagementConnection, verifyManagementOutcome, type OpenVikingManagementFiles } from '../../../packages/core/src/openviking/management.ts';
import { CloudOpenVikingManagementOutcomeSchema, CloudOpenVikingManagementTargetSchema } from '../../../packages/contracts/src/cloud-openviking-management.ts';
import { z } from 'zod';
import { connectCloudOpenVikingManagement } from './cloud-openviking-link.ts';
import { downloadCloudOpenVikingFile, removeCloudOpenVikingPartial, uploadCloudOpenVikingFile } from './cloud-openviking-transfer.ts';

const transferLimit = 256 * 1024 * 1024;
async function selectedJson(path: string, limit: number): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat(), bytes = Buffer.alloc(limit + 1);
    if (!info.isFile() || info.size < 1 || info.size > limit) throw Error('invalid JSON file');
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== info.size) throw Error('JSON file changed');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)));
  } finally { await file.close(); }
}

async function chooseOutput(window: BrowserWindow, name: string): Promise<string | null> {
  const selection = await dialog.showSaveDialog(window, {
    title: name.endsWith('-key.json') ? 'Save the issued key to a private JSON file' : 'Save OpenViking output',
    defaultPath: name, properties: ['dontAddToRecent'],
  });
  const path = selection.filePath;
  if (selection.canceled || !path) return null;
  // Reject an existing destination before any remote key rotation.
  try { await lstat(path); throw Error('destination exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return path;
}

function nativeFiles(window: BrowserWindow): OpenVikingManagementFiles {
  return {
    async selectUpload() {
      const selection = await dialog.showOpenDialog(window, { title: 'Choose a file to upload to OpenViking',
        properties: ['openFile', 'dontAddToRecent'] });
      const path = selection.filePaths[0];
      if (selection.canceled || !path) return null;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > transferLimit) throw Error('OpenViking upload file is invalid');
      const body = await openAsBlob(path);
      if (body.size !== info.size || body.size > transferLimit) throw Error('OpenViking upload file changed');
      return { name: basename(path), body };
    },
    async selectOutput(name) {
      const path = await chooseOutput(window, name);
      if (!path) return null;
      return async stream => {
        const temporary = join(dirname(path), `.flowmate-openviking-${randomUUID()}.tmp`);
        const output = await open(temporary, 'wx', 0o600);
        try {
          const reader = stream.getReader();
          try {
            let written = 0;
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              written += part.value.byteLength;
              if (written > transferLimit) throw Error('OpenViking output exceeds the file limit');
              let offset = 0;
              while (offset < part.value.byteLength) {
                const { bytesWritten } = await output.write(part.value, offset, part.value.byteLength - offset);
                if (!bytesWritten) throw Error('OpenViking output could not be written');
                offset += bytesWritten;
              }
            }
          } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
          } finally { reader.releaseLock(); }
          await output.sync();
          await output.close();
          await link(temporary, path);
        } finally {
          await output.close().catch(() => {});
          await rm(temporary, { force: true }).catch(() => {});
        }
      };
    },
    async selectPrivateOptions() {
      const selection = await dialog.showOpenDialog(window, { title: 'Select private OpenViking options',
        properties: ['openFile', 'dontAddToRecent'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      return selection.canceled || !selection.filePaths[0] ? null : selectedJson(selection.filePaths[0], 65000);
    },
  };
}

const desktopReceiptSchema = OpenVikingManagementReceiptSchema.extend({
  cloudOutputPath: z.string().min(1).max(32768).optional(), cloudUploadId: z.string().uuid().optional(),
});
type Receipt = z.infer<typeof desktopReceiptSchema>;
type Request = z.infer<typeof OpenVikingManagementRequestSchema>;
type CloudLink = Extract<Awaited<ReturnType<typeof connectCloudOpenVikingManagement>>, { ok: true }>['data'];
type CloudConnection = CloudLink & CloudLink['identity'] & { endpoint: string };
type Connection = OpenVikingManagementConnection | CloudConnection;
const isCloud = (connection: Connection): connection is CloudConnection => 'target' in connection;
const outputNames: Partial<Record<Request['method'], string>> = {
  DownloadBytes: 'openviking-content.bin', ExportOVPack: 'openviking-export.ovpack', BackupOVPack: 'openviking-backup.ovpack',
  AdminCreateAccount: 'openviking-user-key.json', AdminCreateAccountWithOptions: 'openviking-user-key.json',
  AdminRegisterUser: 'openviking-user-key.json', AdminRegisterUserWithOptions: 'openviking-user-key.json',
  AdminRegenerateKey: 'openviking-user-key.json', AdminRegenerateKeyWithOptions: 'openviking-user-key.json',
};
function needsUpload(request: Request): boolean {
  switch (request.method) {
    case 'AddResource': return !request.input.sourceUrl;
    case 'AddSkill': return !request.input.data;
    case 'UpdateSkill': return !request.input.data && !(request.input.extra as { from_source?: boolean } | undefined)?.from_source;
    case 'ImportOVPack': case 'RestoreOVPack': return true;
    case 'Find': case 'Search': case 'SearchContext': return request.input.imageFromFile === true;
    default: return false;
  }
}
const summary = (receipt: Receipt): OpenVikingManagementReceipt =>
  ({ operationId: receipt.operationId, state: receipt.state, method: receipt.request.method,
    ...(receipt.taskId ? { taskId: receipt.taskId } : {}) });
const unresolved = (receipt: Receipt) => ['unknown', 'accepted', 'running'].includes(receipt.state);

export function createDesktopOpenVikingManagement(owner: () => BrowserWindow | null | undefined, dataRoot: () => string) {
  let current: { id: string; connection: Connection } | undefined;
  let pendingUpload: { request: Request; operationId: string; uploadId: string; name: string; body: Blob } | undefined;
  let busy = false;
  const unavailable = () => fail(appError('memory_unavailable', 'runtime', 'Connect the original management identity first.', true));
  const receiptFailure = () => fail(appError('operation_result_unknown', 'storage', 'Check the original OpenViking operation receipt before continuing.', true));
  const cancelled = () => fail(appError('operation_cancelled', 'input', 'The OpenViking operation was cancelled.'));
  function ledger(connection: Connection) {
    const scope = isCloud(connection) ? ['cloud', connection.workspaceId, String(connection.target.target.port),
      ...connection.target.target.host.toLowerCase().replace(/:/g, '~').split('.').map(part => 'host-' + part),
      'login-' + connection.target.target.username] : [new URL(connection.endpoint).port];
    const identity = connection.role === 'S' ? [] : [connection.accountId, connection.userId];
    if (connection.role === 'P') identity.push(connection.peerId);
    const components = identity.map(value => 'id-' + value!.replace(/[.A-Z]/g, character => character === '.' ? '~~' : '~' + character.toLowerCase()));
    return createCredentialStore(join(dataRoot(), 'security', 'openviking-management', ...scope, connection.role, ...components, 'receipt.json'), systemSecureStorage);
  }
  async function readReceipt(connection: Connection) {
    const value = await ledger(connection).read();
    if (!value.ok || value.data === null) return value.ok ? ok(null) : value;
    try { return ok(desktopReceiptSchema.parse(JSON.parse(value.data))); }
    catch { return receiptFailure(); }
  }
  async function discardPendingUpload() {
    const upload = pendingUpload, original = current?.connection;
    pendingUpload = undefined;
    if (upload && original && isCloud(original))
      await original.request({ type: 'upload_release', input: { operationId: upload.operationId, uploadId: upload.uploadId } });
  }
  async function clearCloudFiles(connection: CloudConnection, receipt: Receipt) {
    const { operationId, cloudOutputPath, cloudUploadId } = receipt;
    if (cloudUploadId) await connection.request({ type: 'upload_release', input: { operationId, uploadId: cloudUploadId } });
    if (cloudOutputPath) {
      await removeCloudOpenVikingPartial(cloudOutputPath, operationId).catch(() => {});
      await connection.request({ type: 'download_release', input: { operationId } });
    }
  }
  async function cloudOutcome(connection: CloudConnection, receipt: Receipt) {
    const checked = await connection.request({ type: 'outcome', input: {
      operationId: receipt.operationId, request: receipt.request, taskId: receipt.taskId,
    } });
    if (!checked.ok) return checked;
    const outcome = CloudOpenVikingManagementOutcomeSchema.safeParse(checked.data);
    return outcome.success ? ok(outcome.data.state) : receiptFailure();
  }

  return {
    async connect() {
      const window = owner();
      if (!window || busy) return unavailable();
      busy = true;
      try {
        const selection = await dialog.showOpenDialog(window, { title: 'Select an OpenViking management identity',
          properties: ['openFile', 'dontAddToRecent'], filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (selection.canceled || !selection.filePaths[0]) return ok(null);
        let raw: unknown;
        try {
          raw = await selectedJson(selection.filePaths[0], 8192);
        } catch { return fail(appError('input_invalid', 'input', 'The OpenViking identity file is invalid.')); }
        const local = OpenVikingManagementConnectionSchema.safeParse(raw);
        const cloud = CloudOpenVikingManagementTargetSchema.safeParse(raw);
        const remote = cloud.success ? cloud.data : null;
        const identity = local.success ? local.data : remote;
        if (!identity) return fail(appError('input_invalid', 'input', 'The OpenViking identity file is invalid.'));
        const endpoint = 'kind' in identity
          ? `ssh://${identity.target.username}@${identity.target.host}:${identity.target.port}` : identity.endpoint;
        const confirm = await dialog.showMessageBox(window, { type: 'question', title: 'Connect OpenViking management',
          message: `Verify the ${identity.role} identity with ${endpoint}?`,
          detail: 'kind' in identity || identity.role === 'S' ? 'Dedicated management identity' : `Account ${identity.accountId}, user ${identity.userId}`,
          buttons: ['Cancel', 'Connect'], cancelId: 0, defaultId: 0 });
        if (confirm.response !== 1) return ok(null);
        let connection: Connection;
        if ('kind' in identity) {
          const result = await connectCloudOpenVikingManagement(identity);
          if (!result.ok) return result;
          connection = { ...result.data, ...result.data.identity, endpoint };
        } else {
          if (!await verifyManagementConnection(identity)) return fail(appError('memory_scope_denied', 'input',
            'The service did not verify the selected identity and role.'));
          connection = identity;
        }
        if (window.isDestroyed() || owner() !== window) { if (isCloud(connection)) connection.close(); return unavailable(); }
        await discardPendingUpload();
        if (current && isCloud(current.connection)) current.connection.close();
        current = { id: randomUUID(), connection };
        const view: OpenVikingManagementView = { connectionId: current.id, role: connection.role, endpoint: connection.endpoint,
          accountId: connection.role === 'S' ? null : connection.accountId };
        return ok(view);
      } finally { busy = false; }
    },
    async disconnect(raw: unknown) {
      if (busy || current?.id !== raw) return unavailable();
      busy = true;
      try {
        await discardPendingUpload();
        if (current && isCloud(current.connection)) current.connection.close();
        current = undefined;
        return ok(undefined);
      } finally { busy = false; }
    },
    async execute(raw: unknown) {
      const checked = OpenVikingManagementRequestSchema.safeParse(raw), original = current, window = owner();
      if (!checked.success) return fail(appError('input_invalid', 'input', 'The management operation is invalid.'));
      if (!original || busy || !window || original.id !== checked.data.connectionId) return unavailable();
      busy = true;
      try {
        const request = checked.data;
        if (request.method === 'CreateSession' && request.input.sessionId === undefined)
          request.input = { ...request.input, sessionId: `flowmate-management-${randomUUID()}` };
        const connection = original.connection, mutates = isOpenVikingManagementWrite(request.method, request.input);
        const outputName = isCloud(connection) ? outputNames[request.method] : undefined;
        if (mutates || outputName) {
          const previous = await readReceipt(original.connection);
          if (!previous.ok) return previous;
          if (previous.data && unresolved(previous.data)) return receiptFailure();
        }
        let receipt: Receipt | undefined, failedToRecord = false;
        const sameWindow = () => !window.isDestroyed() && owner() === window && current === original;
        const approve = async () => {
          const identity = connection.role === 'S' ? 'System administrator'
            : `Account ${connection.accountId}, user ${connection.userId}`;
          const confirm = await dialog.showMessageBox(window, { type: 'warning', title: 'Confirm OpenViking change',
            message: `Run ${request.method} on ${connection.endpoint}?`,
            detail: identity + '\n\n' + JSON.stringify(request.input, null, 2),
            buttons: ['Cancel', 'Apply change'], defaultId: 0, cancelId: 0 });
          return confirm.response === 1 && sameWindow();
        };
        const record = async (proposed: Receipt) => {
          const recorded = await ledger(connection).write(JSON.stringify(proposed));
          if (!recorded.ok) { failedToRecord = true; return false; }
          receipt = proposed;
          return true;
        };
        let result;
        if (isCloud(connection)) {
          if (mutates && !await approve()) return cancelled();
          const files = nativeFiles(window);
          let operationId: string = randomUUID();
          let cloudUploadId: string | undefined, cloudOutputPath: string | undefined;
          const priorUpload = pendingUpload;
          if (priorUpload && !isDeepStrictEqual(priorUpload.request, request)) await discardPendingUpload();
          if (needsUpload(request)) {
            if (!pendingUpload) {
              const selected = await files.selectUpload();
              if (!selected || !sameWindow()) return cancelled();
              pendingUpload = { ...selected, request, operationId, uploadId: randomUUID() };
            }
            operationId = pendingUpload.operationId;
            cloudUploadId = pendingUpload.uploadId;
            const uploaded = await uploadCloudOpenVikingFile(connection.request, pendingUpload);
            if (!uploaded.ok) return uploaded;
          }
          let privateOptions: Record<string, unknown> | undefined;
          if (request.input.privateOptionsFromFile === true) {
            const chosen = await files.selectPrivateOptions();
            if (chosen === null) return cancelled();
            const parsed = z.record(z.unknown()).safeParse(chosen);
            if (!parsed.success) return fail(appError('input_invalid', 'input', 'The private options file is invalid.'));
            privateOptions = parsed.data;
          }
          if (outputName) {
            cloudOutputPath = await chooseOutput(window, outputName) ?? undefined;
            if (!cloudOutputPath) return cancelled();
          }
          if (!sameWindow()) return cancelled();
          if ((mutates || outputName) && !await record({ operationId, state: 'unknown', request, cloudOutputPath, cloudUploadId })) return receiptFailure();
          if (cloudUploadId) pendingUpload = undefined;
          result = await connection.request({ type: 'execute', input: { operationId, request, uploadId: cloudUploadId,
            output: cloudOutputPath ? true : undefined, privateOptions } });
          if (cloudUploadId && !receipt)
            await connection.request({ type: 'upload_release', input: { operationId, uploadId: cloudUploadId } });
          if (cloudOutputPath && result.ok) {
            const downloaded = await downloadCloudOpenVikingFile(connection.request, operationId, cloudOutputPath);
            if (!downloaded.ok) return downloaded;
          }
        } else {
          result = await runOpenVikingManagement(connection, request, async () => await approve()
            && await record({ operationId: randomUUID(), state: 'unknown', request }), globalThis.fetch, nativeFiles(window));
        }
        if (failedToRecord) return receiptFailure();
        if (!receipt) return result;
        if (result.ok) {
          const task = OpenVikingManagementTaskIdSchema.safeParse(result.data && typeof result.data === 'object' && 'task_id' in result.data
            ? result.data.task_id : undefined);
          const state = connection.role === 'P' && task.success
            ? { state: 'accepted', taskId: task.data } : { state: 'confirmed' };
          const saved = await ledger(connection).write(JSON.stringify({ ...receipt, ...state, cloudOutputPath: undefined, cloudUploadId: undefined }));
          if (saved.ok && isCloud(connection)) await clearCloudFiles(connection, receipt);
          return saved.ok ? result : receiptFailure();
        }
        if (result.error.code === 'operation_cancelled' || result.error.code === 'input_invalid') {
          const cleared = await ledger(connection).remove();
          if (!cleared.ok) return receiptFailure();
          if (isCloud(connection)) await clearCloudFiles(connection, receipt);
        }
        return isCloud(connection) && result.error.code === 'cloud_openviking_transport_lost' ? receiptFailure() : result;
      } catch {
        return fail(appError('cloud_openviking_transfer_unavailable', 'storage', 'The selected OpenViking file or receipt could not be confirmed.', true));
      } finally { busy = false; }
    },
    async receipt(connectionId: unknown) {
      if (!current || current.id !== connectionId) return unavailable();
      const result = await readReceipt(current.connection);
      return result.ok ? ok(result.data ? summary(result.data) : null) : result;
    },
    async resolveReceipt(raw: unknown) {
      const request = OpenVikingManagementReceiptActionSchema.safeParse(raw), original = current, window = owner();
      if (!request.success || !original || busy || !window || request.data.connectionId !== original.id) return unavailable();
      busy = true;
      try {
        const result = await readReceipt(original.connection);
        if (!result.ok) return result;
        const receipt = result.data;
        if (!receipt || receipt.operationId !== request.data.operationId) return unavailable();
        if (!unresolved(receipt)) return ok(summary(receipt));
        const connection = original.connection;
        if (request.data.action === 'check') {
          if (isCloud(connection)) {
            if (receipt.cloudOutputPath) {
              const confirm = await dialog.showMessageBox(window, { type: 'question', title: 'Resume saving OpenViking output',
                message: `Save the original output to ${receipt.cloudOutputPath}?`, buttons: ['Cancel', 'Resume'], defaultId: 0, cancelId: 0 });
              if (confirm.response !== 1 || window.isDestroyed() || owner() !== window) return ok(summary(receipt));
              const downloaded = await downloadCloudOpenVikingFile(connection.request, receipt.operationId, receipt.cloudOutputPath);
              if (downloaded.ok) receipt.state = 'confirmed';
              else {
                const outcome = await cloudOutcome(connection, receipt);
                if (!outcome.ok || outcome.data !== 'failed' && outcome.data !== 'cancelled') return downloaded;
                receipt.state = outcome.data;
              }
            } else {
              const checked = await cloudOutcome(connection, receipt);
              if (!checked.ok) return checked;
              receipt.state = checked.data;
            }
          } else if (receipt.taskId) {
            const status = await readManagementTaskStatus(connection, receipt.request, receipt.taskId);
            if (status) receipt.state = status;
          } else if (await verifyManagementOutcome(connection, receipt.request)) receipt.state = 'verified';
        } else {
          const confirm = await dialog.showMessageBox(window, { type: 'warning', title: 'Stop checking this operation',
            message: `Abandon reconciliation for ${receipt.request.method}?`,
            detail: 'The remote outcome may remain unknown. This closes the local receipt.',
            buttons: ['Cancel', 'Abandon'], defaultId: 0, cancelId: 0 });
          if (confirm.response === 1) receipt.state = 'abandoned';
        }
        const settled = !unresolved(receipt);
        const saved = await ledger(connection).write(JSON.stringify(settled ? { ...receipt, cloudOutputPath: undefined, cloudUploadId: undefined } : receipt));
        if (saved.ok && settled && isCloud(connection)) await clearCloudFiles(connection, receipt);
        return saved.ok ? ok(summary(receipt)) : saved;
      } finally { busy = false; }
    },
  };
}
