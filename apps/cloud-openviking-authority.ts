import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { appError, CloudWorkspaceIdSchema, fail, ok, type Result } from '@flowmate/contracts';
import {
  CloudOpenVikingManagementEnvelopeSchema, CloudOpenVikingManagementIdentitySchema,
  type CloudOpenVikingManagementExecuteInput, type CloudOpenVikingTransferCommand,
} from '../packages/contracts/src/cloud-openviking-management.ts';
import {
  isOpenVikingManagementWrite, openVikingManagement, OpenVikingManagementConnectionSchema, OpenVikingManagementReceiptSchema,
  OpenVikingManagementTaskIdSchema, type OpenVikingManagementConnection,
} from '../packages/contracts/src/openviking-management.ts';
import {
  readManagementTaskStatus, runOpenVikingManagement, verifyManagementConnection, verifyManagementOutcome, type OpenVikingManagementFiles,
} from '../packages/core/src/openviking/management.ts';
import { writeSynced } from '../packages/core/src/skill-hub/resources.ts';
import { listenCloudUnixRpc } from './cloud-unix-rpc.ts';
import { createCloudOpenVikingTransfer } from './cloud-openviking-transfer.ts';
import type { z } from 'zod';

type Transfer = {
  handleTransfer(command: CloudOpenVikingTransferCommand): Promise<Result<unknown>>;
  files(input: CloudOpenVikingManagementExecuteInput): OpenVikingManagementFiles;
};
type Listener = { close(): Promise<Result<void>> };
export type CloudOpenVikingManagementRoleBinding = { socketPath: string; connection: OpenVikingManagementConnection };
type RoleOptions = { workspaceId: string; connection: OpenVikingManagementConnection; root: string; transfer?: Transfer; transport?: typeof fetch };
type Receipt = z.infer<typeof OpenVikingManagementReceiptSchema>;

const invalid = () => fail(appError('input_invalid', 'input', 'The cloud OpenViking request is invalid.'));
const denied = () => fail(appError('memory_scope_denied', 'input', 'This cloud OpenViking identity does not authorize the operation.'));
const unknown = () => fail(appError('operation_result_unknown', 'runtime', 'Check the original cloud OpenViking operation before retrying.', true));
const busy = () => fail(appError('cloud_openviking_busy', 'runtime', 'The original cloud OpenViking operation is still active.', true));
const unavailable = () => fail(appError('cloud_transport_unavailable', 'runtime', 'The cloud OpenViking management endpoint is unavailable.', true));

function privateDirectory(path: string) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error; }
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path
    || typeof process.getuid === 'function' && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) throw Error('unsafe_openviking_directory');
  return path;
}

function syncDirectory(path: string) {
  if (process.platform !== 'linux') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function createCloudOpenVikingManagementHandler(options: RoleOptions) {
  const { workspaceId, connection, root, transfer, transport = globalThis.fetch } = options;
  let active: string | undefined;
  const identity = CloudOpenVikingManagementIdentitySchema.parse({
    role: connection.role, workspaceId, accountId: 'accountId' in connection ? connection.accountId : null,
    userId: 'userId' in connection ? connection.userId : null, peerId: 'peerId' in connection ? connection.peerId : null,
  });
  const canRun = (request: Receipt['request']) => openVikingManagement[request.method].roles.includes(connection.role);
  const receiptPath = (id: string) => join(root, `${id}.json`);
  function read(id: string): Receipt | null {
    try { return OpenVikingManagementReceiptSchema.parse(JSON.parse(readFileSync(receiptPath(id), 'utf8'))); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }
  function save(receipt: Receipt) {
    const temporary = join(root, `.${randomUUID()}.tmp`);
    try {
      writeSynced(temporary, JSON.stringify(receipt));
      renameSync(temporary, receiptPath(receipt.operationId));
      syncDirectory(root);
    } finally { rmSync(temporary, { force: true }); }
  }
  return async (raw: unknown): Promise<Result<unknown>> => {
    const parsed = CloudOpenVikingManagementEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return invalid();
    if (parsed.data.workspaceId !== workspaceId) return denied();
    const { command } = parsed.data;
    if (command.type === 'info') return await verifyManagementConnection(connection, transport) ? ok(identity) : denied();
    const { operationId } = command.input;
    if (command.type !== 'execute' && command.type !== 'outcome') {
      if (active === operationId) return busy();
      if (!transfer) return unavailable();
      return transfer.handleTransfer(command);
    }
    const { request } = command.input;
    if (!canRun(request)) return denied();
    if (active !== undefined) {
      if (active !== operationId) return busy();
      return command.type === 'outcome' ? ok({ state: 'unknown' }) : unknown();
    }
    active = operationId;
    try {
      if (command.type === 'outcome') {
        const receipt = read(operationId);
        if (!receipt) return ok({ state: 'unknown' });
        if (receipt.request.method !== request.method || !isDeepStrictEqual(receipt.request.input, request.input)
          || command.input.taskId !== undefined && command.input.taskId !== receipt.taskId) return denied();
        if (!await verifyManagementConnection(connection, transport)) return denied();
        if (receipt.state === 'accepted' || receipt.state === 'running') {
          const state = receipt.taskId ? await readManagementTaskStatus(connection, receipt.request, receipt.taskId, transport) : undefined;
          if (state && state !== receipt.state) save({ ...receipt, state });
          return ok({ state: state ?? receipt.state });
        }
        if (receipt.state === 'unknown' && await verifyManagementOutcome(connection, receipt.request, transport)) {
          save({ ...receipt, state: 'verified' });
          return ok({ state: 'verified' });
        }
        return ok({ state: receipt.state });
      }
      if (request.method === 'CreateSession' && request.input.sessionId === undefined) return invalid();
      const mutates = isOpenVikingManagementWrite(request.method, request.input);
      const tracked = mutates || command.input.output === true;
      const proposed: Receipt = { operationId, request, state: 'unknown' };
      let claimed = false, claimFailed = false;
      const claim = async () => {
        try {
          writeSynced(receiptPath(operationId), JSON.stringify(proposed));
          syncDirectory(root);
          claimed = true;
          return true;
        } catch { claimFailed = true; return false; }
      };
      if (tracked && read(operationId)) return unknown();
      if (tracked && !mutates && !await claim()) return unknown();
      const result = await runOpenVikingManagement(connection, request, claim, transport, transfer?.files(command.input));
      if (claimFailed) return unknown();
      if (claimed && result.ok) {
        const data = result.data;
        const task = OpenVikingManagementTaskIdSchema.safeParse(data && typeof data === 'object' && 'task_id' in data ? data.task_id : undefined);
        if (connection.role === 'P' && task.success) save({ ...proposed, state: 'accepted', taskId: task.data });
        else save({ ...proposed, state: 'confirmed' });
      } else if (claimed && !result.ok && result.error.code !== 'operation_result_unknown') {
        save({ ...proposed, state: result.error.code === 'operation_cancelled' ? 'cancelled' : 'failed' });
      }
      return result;
    } catch { return unknown(); }
    finally { active = undefined; }
  };
}

export async function startCloudOpenVikingManagement(options: {
  workspaceId: string; productRoot: string; roles: readonly CloudOpenVikingManagementRoleBinding[]; transport?: typeof fetch;
}): Promise<Result<Listener>> {
  const listeners: Listener[] = [];
  const close = async () => {
    const results = await Promise.all(listeners.map(listener => listener.close()));
    return results.find(result => !result.ok) ?? ok(undefined);
  };
  const { workspaceId, roles } = options;
  if (!CloudWorkspaceIdSchema.safeParse(workspaceId).success || !roles.length || new Set(roles.map(role => role.connection.role)).size !== roles.length
    || new Set(roles.map(role => role.socketPath)).size !== roles.length) return invalid();
  try {
    const workspaceRoot = privateDirectory(join(privateDirectory(join(options.productRoot, 'openviking-management')), workspaceId));
    for (const { socketPath, connection: raw } of roles) {
      const connection = OpenVikingManagementConnectionSchema.parse(raw);
      const port = new URL(connection.endpoint).port;
      const parts = connection.role === 'S' ? [] : [connection.accountId, connection.userId];
      if (connection.role === 'P') parts.push(connection.peerId);
      let directory = privateDirectory(join(workspaceRoot, connection.role));
      for (const part of [port, ...parts]) directory = privateDirectory(join(directory, part));
      const root = privateDirectory(join(directory, 'receipts'));
      const transfer = createCloudOpenVikingTransfer(privateDirectory(join(directory, 'transfer')));
      const handle = createCloudOpenVikingManagementHandler({ workspaceId, connection, root, transfer, transport: options.transport });
      const listener = await listenCloudUnixRpc({ socketPath, allowStaleSocket: true, handle });
      if (!listener.ok) {
        const closed = await close();
        return closed.ok ? listener : closed;
      }
      listeners.push(listener.data);
    }
    return ok({ close });
  } catch {
    const closed = await close();
    return closed.ok ? unavailable() : closed;
  }
}
