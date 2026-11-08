import { OpenVikingClient, isOpenVikingError } from '@openviking/sdk';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, fail, ok, type Result } from '@flowmate/contracts';
import {
  isOpenVikingManagementWrite, openVikingManagement, OpenVikingManagementRequestSchema, type OpenVikingManagementConnection, type OpenVikingManagementMethod,
} from '../../../contracts/src/openviking-management.ts';
import { verifyOpenVikingIdentity } from './identity.ts';
import { createOpenVikingGroupAdmin } from './groups.ts';

export function verifyManagementConnection(connection: OpenVikingManagementConnection, transport: typeof fetch = globalThis.fetch) {
  const role = ({ P: 'user', A: 'admin', S: 'root' } as const)[connection.role];
  return verifyOpenVikingIdentity({ ...connection, role, fetch: transport, signal: AbortSignal.timeout(5000) });
}

const forbidden = () => fail(appError('memory_scope_denied', 'input', 'This OpenViking role does not authorize the operation.'));
const invalid = () => fail(appError('input_invalid', 'input', 'The OpenViking management parameters are invalid.'));
function canonicalUri(uri: string): boolean {
  return /^viking:\/\/(user|resources|agent|session)(?:\/|$)/.test(uri) && uri.split('/').slice(3)
    .every(part => part && part !== '.' && part !== '..' && !/[\\%?#\u0000-\u001f]/.test(part));
}
function ownUri(uri: string, owner: Extract<OpenVikingManagementConnection, { role: 'P' }>): boolean {
  const root = `viking://user/${owner.userId}`;
  return canonicalUri(uri) && (uri === root || uri.startsWith(root + '/') || uri === 'viking://resources' || uri.startsWith('viking://resources/'));
}

async function readReply(response: Response): Promise<unknown> {
  if (!response.body) throw Error('empty OpenViking response');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '', size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 262144) { await reader.cancel(); throw Error('OpenViking response exceeds the management limit'); }
      body += decoder.decode(next.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally { reader.releaseLock(); }
}

// List and diagnostics responses can carry credential metadata on some server configurations.
function visibleResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(visibleResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !/(?:api.?key|user.?key|access.?key|auth.?config|authorization|token|secret|password|credential|seed)/i.test(key) || key === 'api_key_available')
    .map(([key, item]) => [key, visibleResult(item)]));
}

const observers = { QueueStatus: 'queue', VikingDBStatus: 'vikingdb', ModelsStatus: 'models', GetStatus: 'system', IsHealthy: 'system' } as const;
const skillOperations = new Set(['AddSkill', 'ListSkills', 'FindSkills', 'ValidateSkill', 'GetSkill', 'UpdateSkill', 'DeleteSkill']);
const listResults = new Set(['List', 'Tree', 'ListSessions', 'ListTasks', 'AdminListAccounts', 'AdminListAccountsWithOptions',
  'AdminListUsers', 'AdminListUsersWithOptions']);
const textResults = new Set(['Read', 'Abstract', 'Overview']);
const keyOperations = new Set([
  'AdminCreateAccount', 'AdminCreateAccountWithOptions', 'AdminRegisterUser', 'AdminRegisterUserWithOptions',
  'AdminRegenerateKey', 'AdminRegenerateKeyWithOptions',
]);
export type OpenVikingManagementFiles = {
  selectUpload(): Promise<{ body: Blob; name: string } | null>;
  selectOutput(name: string): Promise<((stream: ReadableStream<Uint8Array>) => Promise<void>) | null>;
  selectPrivateOptions(): Promise<unknown>;
};
export async function verifyManagementOutcome(connection: OpenVikingManagementConnection,
  original: z.infer<typeof OpenVikingManagementRequestSchema>, transport: typeof fetch = globalThis.fetch): Promise<boolean> {
  const fields = original.input;
  const read = (method: OpenVikingManagementMethod, input: Record<string, unknown>) =>
    runOpenVikingManagement(connection, { ...original, method, input }, async () => false, transport);
  switch (original.method) {
    case 'CreateSession': case 'GetSession': {
      if (original.method === 'GetSession' && fields.auto_create !== true) return false;
      const result = await read('GetSession', { sessionId: fields.sessionId });
      if (!result.ok || !result.data || typeof result.data !== 'object') return false;
      const actual = result.data as Record<string, unknown>;
      const autoCommit = fields.disableAutoCommit ? null : fields.auto_commit_policy;
      return actual.session_id === fields.sessionId && (autoCommit === undefined || isDeepStrictEqual(actual.auto_commit_policy, autoCommit))
        && (fields.memory_policy === undefined || isDeepStrictEqual(actual.memory_policy, fields.memory_policy))
        && (fields.memory_extraction_config === undefined || isDeepStrictEqual(actual.memory_extraction_config, fields.memory_extraction_config));
    }
    case 'DeleteSession': {
      const result = await read('SessionExists', { sessionId: fields.sessionId });
      return result.ok && result.data === false;
    }
    case 'Write': {
      if (fields.mode === 'append' || fields.tags !== undefined || fields.tag_mode !== undefined || fields.acl !== undefined
        || fields.wait === true || fields.processing_mode !== undefined) return false;
      const result = await read('Read', { uri: fields.uri, offset: 0, limit: -1 });
      return result.ok && result.data === fields.content;
    }
    case 'AdminCreateGroup': case 'AdminDeleteGroup': {
      const result = await read('AdminListGroups', {});
      const groups = result.ok && z.array(z.object({ group_id: z.string() })).safeParse(result.data);
      return !!groups && groups.success && groups.data.some(group => group.group_id === fields.groupId) === (original.method === 'AdminCreateGroup');
    }
    case 'AdminAddGroupMember': case 'AdminRemoveGroupMember': {
      const result = await read('AdminListGroupMembers', { groupId: fields.groupId });
      const membership = result.ok && z.object({ members: z.array(z.string()) }).safeParse(result.data);
      return !!membership && membership.success && typeof fields.userId === 'string'
        && membership.data.members.includes(fields.userId) === (original.method === 'AdminAddGroupMember');
    }
    default: return false;
  }
}

export async function readManagementTaskStatus(connection: OpenVikingManagementConnection,
  original: z.infer<typeof OpenVikingManagementRequestSchema>, taskId: string, transport: typeof fetch = globalThis.fetch) {
  const result = await runOpenVikingManagement(connection, { ...original, method: 'GetTask', input: { taskId } }, async () => false, transport);
  if (!result.ok) return undefined;
  const task = z.object({ task_id: z.literal(taskId), status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']) }).safeParse(result.data);
  if (!task.success) return undefined;
  return task.data.status === 'pending' ? 'accepted' : task.data.status;
}
function httpsSource(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

export async function runOpenVikingManagement(connection: OpenVikingManagementConnection, raw: unknown, authorizeWrite: () => Promise<boolean>,
  transport: typeof fetch = globalThis.fetch, files?: OpenVikingManagementFiles): Promise<Result<unknown>> {
  const request = OpenVikingManagementRequestSchema.safeParse(raw);
  if (!request.success) return invalid();
  const { method } = request.data;
  const spec = openVikingManagement[method];
  if (!spec.roles.includes(connection.role)) return forbidden();
  const checked = spec.input.safeParse(request.data.input);
  if (!checked.success) return invalid();
  const fields: Record<string, unknown> = checked.data;
  const mutates = isOpenVikingManagementWrite(method, fields);
  const accountId = connection.role === 'A' ? connection.accountId : fields.accountId;
  if (connection.role === 'A' && fields.accountId !== undefined && fields.accountId !== connection.accountId) return forbidden();
  const accountPath = typeof accountId === 'string' ? `/api/v1/admin/accounts/${encodeURIComponent(accountId)}` : undefined;
  const userPath = accountPath && `${accountPath}/users/${encodeURIComponent(String(fields.userId))}`;
  const { uri: target, to_uri: destination, exclude_uri: excluded, sessionId, archiveId, taskId,
    disableAutoCommit, eventTags, node_limit, skillName, privateOptionsFromFile, extra, imageFromFile, ...rest } = fields;
  const extraOptions = extra as Record<string, unknown> | undefined;
  const uris = [target, destination, excluded, ...[fields.target_uri].flat(),
    ...((fields.operations as { uri: string }[] | undefined)?.map(item => item.uri) ?? []),
    fields.to, fields.parent, ...[fields.from ?? []].flat(), ...[fields.exclude_uris ?? []].flat()];
  for (const value of uris) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !canonicalUri(value)) return forbidden();
    if (connection.role === 'P' && !ownUri(value, connection) && !(skillOperations.has(method) && value === 'viking://agent/skills')) return forbidden();
    if (connection.role === 'P' && mutates && value.startsWith(`viking://user/${connection.userId}/sessions/`)) return forbidden();
  }
  if (method === 'Remove' && (target === 'viking://resources' || connection.role === 'P' && target === `viking://user/${connection.userId}`))
    return forbidden();
  if (method === 'Compile' && connection.role === 'P' && typeof fields.skill === 'string' && fields.skill.startsWith('viking://')
    && (!canonicalUri(fields.skill) || !(fields.skill.startsWith(`viking://user/${connection.userId}/skills/`)
      || fields.skill.startsWith('viking://agent/skills/')))) return forbidden();
  if (method === 'GetSession' && mutates && !String(sessionId).startsWith('flowmate-management-')) return forbidden();
  if (imageFromFile && fields.image_url !== undefined) return invalid();
  if (fields.image_url !== undefined && !httpsSource(fields.image_url)
    && !(connection.role === 'P' && typeof fields.image_url === 'string' && ownUri(fields.image_url, connection))) return invalid();
  if (method === 'BatchWrite') {
    const root = String(target);
    if (!(fields.operations as { uri: string; content?: string; content_base64?: string }[]).every(item =>
      item.uri.startsWith(root + '/') && (item.content === undefined) !== (item.content_base64 === undefined))) return invalid();
  }
  if (method === 'AddResource' && (fields.to && fields.parent || fields.sourceUrl !== undefined && !httpsSource(fields.sourceUrl))) return invalid();
  if (method === 'AddResource' && fields.args && typeof fields.args === 'object' && Object.hasOwn(fields.args, 'auth_config')) return invalid();
  if (method === 'AddResource' && privateOptionsFromFile && !fields.sourceUrl) return invalid();
  if (method === 'AddResource' && extraOptions?.source_name !== undefined && !fields.sourceUrl) return invalid();
  const addType = fields.add_type || extraOptions?.add_type;
  if (method === 'AddResource' && (fields.add_type && extraOptions?.add_type !== undefined
    || typeof addType === 'string' && addType.trim() && (!fields.sourceUrl || !fields.to))) return invalid();
  if (method === 'PreflightOpenVikingAsset' && !httpsSource(fields.repo_url)) return invalid();
  if (method === 'CommitSession' && eventTags !== undefined && extraOptions?.extraction_metadata !== undefined) return invalid();
  if (method === 'UpdateSkill' && extraOptions?.from_source === true && fields.data !== undefined) return invalid();
  if (method === 'AddMessage' && fields.content === undefined && fields.parts === undefined) return invalid();
  if (method === 'BatchAddMessages' && !(fields.messages as { content?: string; parts?: unknown[] }[]).every(message =>
    message.content !== undefined || message.parts !== undefined)) return invalid();
  if (connection.role === 'P' && method === 'AddMessage' && fields.peer_id !== undefined && fields.peer_id !== connection.peerId)
    return forbidden();
  if (connection.role === 'P' && method === 'BatchAddMessages' && (fields.messages as { peer_id?: string }[]).some(message =>
    message.peer_id !== undefined && message.peer_id !== connection.peerId)) return forbidden();
  if ((method === 'UpdateWatch' || method === 'DeleteWatch' || method === 'TriggerWatch') && !taskId && !destination) return invalid();
  if (method === 'UpdateWatch' && ['watch_interval', 'is_active', 'reason', 'instruction'].every(key => fields[key] === undefined)) return invalid();
  const sessionPath = `/api/v1/sessions/${encodeURIComponent(String(sessionId))}`;
  const taskPath = `/api/v1/tasks/${encodeURIComponent(String(taskId))}`;
  const skillPath = `/api/v1/skills/${encodeURIComponent(String(skillName))}`;
  const watchPath = taskId ? `/api/v1/watches/${encodeURIComponent(String(taskId))}` : '/api/v1/watches';
  if (!await verifyManagementConnection(connection, transport)) return forbidden();
  if (mutates && !await authorizeWrite()) return fail(appError('operation_cancelled', 'input', 'The OpenViking change was cancelled.'));
  const unknown = () => fail(appError(mutates ? 'operation_result_unknown' : 'openviking_unavailable', 'runtime',
    mutates ? 'Check the original target before retrying the change.' : 'OpenViking could not confirm the requested information.', true));
  const timeout = AbortSignal.timeout(Math.ceil((Number(fields.timeout ?? (files ? 120 : 10)) + 5) * 1000));
  const cancelled = () => fail(appError('operation_cancelled', 'input', 'The OpenViking file operation was cancelled.'));
  const headers = { 'X-API-Key': connection.apiKey,
    ...(connection.role === 'P' ? { 'X-OpenViking-Actor-Peer': connection.peerId } : {}) };
  async function call(verb: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string,
    args: Record<string, unknown> = {}, keepPage = false, missing?: false | null,
    query?: Record<string, unknown>): Promise<Result<unknown>> {
    const url = new URL(path, connection.endpoint);
    for (const [key, value] of Object.entries(query ?? (verb === 'GET' || verb === 'DELETE' ? args : {}))) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    const response = await transport(url, { method: verb, signal: timeout, redirect: 'error',
      headers: { ...headers,
        ...(verb === 'GET' || verb === 'DELETE' ? {} : { 'Content-Type': 'application/json' }) },
      ...(verb === 'GET' || verb === 'DELETE' ? {} : { body: JSON.stringify(args) }) });
    if (response.status >= 500) { await response.body?.cancel(); return unknown(); }
    if (!response.ok) {
      if (response.status === 404 && missing !== undefined) {
        const evidence = z.object({ error: z.object({ code: z.literal('NOT_FOUND') }) }).safeParse(await readReply(response));
        if (evidence.success) return ok(missing);
      }
      await response.body?.cancel();
      return fail(appError('openviking_request_failed', 'runtime', `OpenViking rejected the operation (HTTP ${response.status}).`, response.status === 429));
    }
    const payload = await readReply(response);
    if (path === '/health') return ok(z.object({ status: z.literal('ok') }).safeParse(payload).success);
    const envelope = z.object({ status: z.literal('ok'), result: z.unknown(), has_more: z.boolean().optional() }).safeParse(payload);
    if (!envelope.success || envelope.data.result === undefined) return unknown();
    if (keepPage) return Array.isArray(envelope.data.result)
      ? ok({ result: visibleResult(envelope.data.result), hasMore: envelope.data.has_more ?? null }) : unknown();
    const result = envelope.data.result;
    if (listResults.has(method) && !Array.isArray(result)) return unknown();
    if (textResults.has(method) && typeof result !== 'string') return unknown();
    return ok(connection.role === 'P' || keyOperations.has(method) ? envelope.data.result : visibleResult(envelope.data.result));
  }
  async function upload(): Promise<{ temp_file_id: string; source_name: string } | null> {
    const selected = await files?.selectUpload();
    if (!selected) return null;
    const body = new FormData();
    body.append('file', selected.body, selected.name);
    const response = await transport(new URL('/api/v1/resources/temp_upload', connection.endpoint),
      { method: 'POST', headers, body, redirect: 'error', signal: timeout });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('OpenViking did not accept the upload');
    }
    const uploaded = z.object({ status: z.literal('ok'), result: z.object({ temp_file_id: z.string().min(1).max(512) }) })
      .parse(await readReply(response));
    return { ...uploaded.result, source_name: selected.name };
  }
  async function download(path: string, args: Record<string, unknown>, name: string, verb: 'GET' | 'POST'): Promise<Result<unknown>> {
    const save = await files?.selectOutput(name);
    if (!save) return cancelled();
    const url = new URL(path, connection.endpoint);
    if (verb === 'GET') url.searchParams.set('uri', String(args.uri));
    const response = await transport(url, { method: verb, redirect: 'error', signal: timeout,
      headers: verb === 'POST' ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: verb === 'POST' ? JSON.stringify(args) : undefined });
    if (!response.ok || !response.body || verb === 'POST' && (response.headers.get('content-type') ?? '').includes('application/json')) {
      await response.body?.cancel();
      return unknown();
    }
    await save(response.body);
    return ok({ saved: true });
  }
  try {
    if (keyOperations.has(method)) {
      const save = await files?.selectOutput('openviking-user-key.json');
      if (!save) return cancelled();
      const options = privateOptionsFromFile ? await files!.selectPrivateOptions() : {};
      if (options === null) return cancelled();
      const keyOptions = z.object({ seed: z.string().min(1).max(8192).nullable().optional(),
        user_config: z.record(z.unknown()).nullable().optional() }).strict().safeParse(options);
      if (!keyOptions.success) return invalid();
      const create = method === 'AdminCreateAccount' || method === 'AdminCreateAccountWithOptions';
      const register = method === 'AdminRegisterUser' || method === 'AdminRegisterUserWithOptions';
      if (!create && !userPath) return invalid();
      let sent: Result<unknown>;
      if (create) sent = await call('POST', '/api/v1/admin/accounts', { account_id: accountId, admin_user_id: fields.adminUserId, ...keyOptions.data });
      else if (register) sent = await call('POST', `${accountPath}/users`, { user_id: fields.userId, role: fields.role ?? 'user', ...keyOptions.data });
      else sent = await call('POST', `${userPath}/key`, { seed: keyOptions.data.seed });
      if (!sent.ok) return sent;
      const key = z.object({ user_key: z.string().min(1).max(4096) }).safeParse(sent.data);
      if (!key.success) return unknown();
      const receipt = JSON.stringify({ endpoint: connection.endpoint, accountId, userId: create ? fields.adminUserId : fields.userId,
        apiKey: key.data.user_key }, null, 2);
      await save(new Blob([receipt]).stream());
      return ok({ keySaved: true });
    }
    const groupMethod = { AdminCreateGroup: 'create', AdminListGroups: 'list', AdminDeleteGroup: 'delete',
      AdminListGroupMembers: 'members', AdminAddGroupMember: 'add', AdminRemoveGroupMember: 'remove' } as const;
    if (connection.role === 'A' && Object.hasOwn(groupMethod, method)) {
      const groupOp = groupMethod[method as keyof typeof groupMethod];
      const admin = createOpenVikingGroupAdmin({ endpoint: connection.endpoint, apiKey: connection.apiKey, accountId: connection.accountId,
        role: 'account-admin', fetch: transport });
      let result: Result<unknown>;
      if (groupOp === 'list') result = await admin.execute({ operation: groupOp });
      else if (groupOp === 'add' || groupOp === 'remove') result = await admin.execute({ operation: groupOp, groupId: String(fields.groupId), userId: String(fields.userId) });
      else result = await admin.execute({ operation: groupOp, groupId: String(fields.groupId) });
      return result.ok ? ok(visibleResult(result.data)) : result;
    }
    if (Object.hasOwn(observers, method)) {
      const status = await call('GET', `/api/v1/observer/${observers[method as keyof typeof observers]}`, { format: fields.format || undefined });
      return method === 'IsHealthy' && status.ok ? ok(z.object({ is_healthy: z.boolean() }).parse(status.data).is_healthy) : status;
    }
    switch (method) {
      case 'AddResource': {
        const { sourceUrl, args, ...resource } = rest;
        const privateArgs = privateOptionsFromFile ? await files?.selectPrivateOptions() : undefined;
        if (privateOptionsFromFile && !privateArgs) return cancelled();
        const safePrivate = z.object({ auth_config: z.record(z.unknown()) }).strict().optional().safeParse(privateArgs);
        if (!safePrivate.success) return invalid();
        const selected = sourceUrl ? { path: sourceUrl } : await upload();
        if (!selected) return cancelled();
        const resourceArgs = { ...(args as Record<string, unknown> | undefined), ...safePrivate.data };
        const result = await call('POST', '/api/v1/resources', { ...resource, ...extraOptions, ...selected, add_type: addType || undefined,
          reason: fields.reason ?? '', instruction: fields.instruction ?? '',
          wait: fields.wait ?? false, strict: fields.strict ?? false, directly_upload_media: fields.directly_upload_media ?? true,
          watch_interval: fields.watch_interval ?? 0, args: Object.keys(resourceArgs).length ? resourceArgs : undefined });
        return privateOptionsFromFile && result.ok ? ok(visibleResult(result.data)) : result;
      }
      case 'Compile':
        return await call('POST', '/api/v1/compile', { ...rest, instruction: fields.instruction || extraOptions?.reason });
      case 'ResolveOpenVikingAssets': return await call('POST', '/api/v1/openviking-assets/resolve', { manifest_yaml: fields.manifest_yaml,
        catalog_yaml: fields.catalog_yaml || undefined, manifest_label: fields.manifest_label || undefined, catalog_label: fields.catalog_label || undefined });
      case 'PreflightOpenVikingAsset': {
        const auth = privateOptionsFromFile ? await files?.selectPrivateOptions() : undefined;
        if (privateOptionsFromFile && !auth) return cancelled();
        const checked = z.object({ username: z.string().max(256).optional(), token: z.string().max(4096).optional() }).strict().optional().safeParse(auth);
        if (!checked.success) return invalid();
        const authConfig = checked.data ? { username: checked.data.username || undefined, token: checked.data.token || undefined } : undefined;
        const result = await call('POST', '/api/v1/openviking-assets/preflight', { ...rest, connector: 'git',
          branch: fields.branch || undefined, commit: fields.commit || undefined, auth_config: authConfig });
        return result.ok ? ok(visibleResult(result.data)) : result;
      }
      case 'List': case 'ListPage': case 'Tree': case 'TreePage': {
        const ls = method === 'List' || method === 'ListPage';
        return await call('GET', ls ? '/api/v1/fs/ls' : '/api/v1/fs/tree', {
          ...fields, output: fields.output || 'original', abs_limit: fields.abs_limit || (ls ? 256 : 128),
          overview_limit: fields.overview_limit || 4000, node_limit: fields.node_limit || 1000,
          offset: fields.offset || undefined, limit: fields.limit || undefined,
          ...(ls ? {} : { level_limit: fields.level_limit ?? 3 }),
        }, method === 'ListPage' || method === 'TreePage');
      }
      case 'Stat': {
        if (connection.role !== 'P') return forbidden();
        // Keep the SDK call on the verified endpoint and reject redirects.
        const sdk = new OpenVikingClient({ baseUrl: connection.endpoint, apiKey: connection.apiKey, actorPeerId: connection.peerId,
          fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
            const response = await transport(url, { ...init, signal: timeout, redirect: 'error' });
            return Response.json(await readReply(response), { status: response.status });
          }) as typeof fetch });
        return ok(await sdk.stat(String(target)));
      }
      case 'Attrs': return await call('GET', '/api/v1/fs/attrs', fields);
      case 'Read': return await call('GET', '/api/v1/content/read', fields);
      case 'DownloadBytes': return await download('/api/v1/content/download', fields, 'openviking-content.bin', 'GET');
      case 'Abstract': return await call('GET', '/api/v1/content/abstract', fields);
      case 'Overview': return await call('GET', '/api/v1/content/overview', fields);
      case 'Mkdir': return await call('POST', '/api/v1/fs/mkdir', fields);
      case 'Remove': return await call('DELETE', '/api/v1/fs', { ...fields, recursive: fields.recursive ?? false, wait: fields.wait ?? false });
      case 'Move': return await call('POST', '/api/v1/fs/mv', { from_uri: target, to_uri: destination });
      case 'Write': return await call('POST', '/api/v1/content/write', { ...fields, mode: fields.mode ?? 'replace', wait: fields.wait ?? false,
        tag_mode: fields.tags !== undefined || fields.tag_mode === 'clear' ? fields.tag_mode ?? 'replace' : undefined });
      case 'BatchWrite': return await call('POST', '/api/v1/content/batch-write', { ...rest, root_uri: target });
      case 'SetTags': return await call('POST', '/api/v1/fs/attrs/set_tags', { ...fields, tags: fields.tags ?? [], mode: fields.mode ?? 'replace', recursive: fields.recursive ?? false });
      case 'Reindex': return await call('POST', '/api/v1/content/reindex', { ...fields, mode: fields.mode ?? 'vectors_only',
        wait: fields.wait ?? Object.keys(rest).length === 0, recursive: fields.recursive ?? true,
        tag_mode: fields.tags !== undefined || fields.tag_mode === 'clear' ? fields.tag_mode ?? 'replace' : undefined });
      case 'Find': case 'Search': case 'SearchContext': {
        let image = fields.image_url;
        if (imageFromFile) {
          const selected = await files?.selectUpload();
          if (!selected) return cancelled();
          const extension = selected.name.split('.').at(-1)?.toLowerCase();
          const type = ({ png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif' } as Record<string, string>)[extension ?? ''];
          if (!type || !selected.body.size || selected.body.size > 4 * 1024 * 1024) return invalid();
          image = `data:image/${type};base64,${Buffer.from(await selected.body.arrayBuffer()).toString('base64')}`;
        }
        const input = method === 'SearchContext' ? { node_limit, mode: 'context' } : { limit: node_limit ?? (fields.limit || 10) };
        return await call('POST', method === 'Find' ? '/api/v1/search/find' : '/api/v1/search/search', { ...rest, ...input, image_url: image });
      }
      case 'Grep': return await call('POST', '/api/v1/search/grep', { ...fields, case_insensitive: fields.case_insensitive ?? false });
      case 'Glob': return await call('POST', '/api/v1/search/glob', fields);
      case 'CreateSession': return await call('POST', '/api/v1/sessions', { ...rest, session_id: sessionId ?? `flowmate-management-${crypto.randomUUID()}`,
        auto_commit_policy: disableAutoCommit ? null : rest.auto_commit_policy });
      case 'ListSessions': return await call('GET', '/api/v1/sessions');
      case 'GetSession': return await call('GET', sessionPath, fields.auto_create ? { auto_create: true } : {});
      case 'UpdateSessionConfig': return await call('PATCH', `${sessionPath}/config`, rest);
      case 'SessionExists': {
        const session = await call('GET', sessionPath, {}, false, false);
        return session.ok ? ok(session.data !== false) : session;
      }
      case 'GetSessionContext': return await call('GET', `${sessionPath}/context`, { token_budget: fields.token_budget || 128000 });
      case 'GetSessionArchive': return await call('GET', `${sessionPath}/archives/${encodeURIComponent(String(archiveId))}`);
      case 'DeleteSession': return await call('DELETE', sessionPath);
      case 'AddMessage': return await call('POST', `${sessionPath}/messages`, { ...rest, content: rest.parts ? undefined : rest.content });
      case 'BatchAddMessages': return await call('POST', `${sessionPath}/messages/batch`, rest);
      case 'CommitSession': return await call('POST', `${sessionPath}/commit`, { ...rest, ...extraOptions,
        ...(eventTags === undefined ? {} : { extraction_metadata: { event: { tags: eventTags } } }) });
      case 'GetTask': return await call('GET', taskPath, {}, false, null);
      case 'CancelTask': return await call('POST', `${taskPath}/cancel`);
      case 'ListTasks': return await call('GET', '/api/v1/tasks', { task_type: fields.task_type || undefined,
        status: fields.status || undefined, resource_id: fields.resource_id || undefined, limit: fields.limit || undefined });
      case 'AddSkill': case 'UpdateSkill': {
        const selected = fields.data !== undefined || extraOptions?.from_source === true ? {} : await upload();
        if (!selected) return cancelled();
        const uploadField = 'temp_file_id' in selected ? { temp_file_id: selected.temp_file_id } : {};
        return await call(method === 'AddSkill' ? 'POST' : 'PUT', method === 'AddSkill' ? '/api/v1/skills' : skillPath,
          { ...rest, ...extraOptions, ...uploadField, wait: fields.wait ?? false });
      }
      case 'ListSkills': return await call('GET', '/api/v1/skills', { ...rest, node_limit: node_limit || 1000 });
      case 'FindSkills': return await call('POST', '/api/v1/skills/find', { ...fields, limit: fields.limit || 10 });
      case 'ValidateSkill': return await call('POST', '/api/v1/skills/validate', { ...fields, strict: fields.strict ?? false });
      case 'GetSkill': return await call('GET', skillPath, { ...rest, include_files: fields.include_files ?? true, include_source: fields.include_source ?? false });
      case 'DeleteSkill': return await call('DELETE', skillPath, rest);
      case 'ListWatches': return await call('GET', watchPath, { to_uri: destination, active_only: fields.active_only ?? false });
      case 'GetWatch': return await call('GET', watchPath, { to_uri: destination });
      case 'UpdateWatch': return await call('PATCH', watchPath, rest, false, undefined, { to_uri: destination });
      case 'DeleteWatch': return await call('DELETE', watchPath, { to_uri: destination });
      case 'TriggerWatch': return await call('POST', `${watchPath}/trigger`, {}, false, undefined, { to_uri: destination });
      case 'ExportOVPack': return await download('/api/v1/pack/export', { ...fields, include_vectors: fields.include_vectors ?? false }, 'openviking-export.ovpack', 'POST');
      case 'BackupOVPack': return await download('/api/v1/pack/backup', { include_vectors: fields.include_vectors ?? false }, 'openviking-backup.ovpack', 'POST');
      case 'ImportOVPack': case 'RestoreOVPack': {
        const selected = await upload();
        if (!selected) return cancelled();
        return await call('POST', method === 'ImportOVPack' ? '/api/v1/pack/import' : '/api/v1/pack/restore',
          { on_conflict: fields.on_conflict || undefined, vector_mode: fields.vector_mode || undefined,
            parent: target, temp_file_id: selected.temp_file_id });
      }
      case 'ACL': return await call('GET', '/api/v1/acl', fields);
      case 'SetACL': return await call('PUT', '/api/v1/acl', { ...fields, entries: fields.entries ?? [] });
      case 'SetACLMode': return await call('PUT', '/api/v1/acl', fields);
      case 'GrantACL': return await call('POST', '/api/v1/acl/grant', fields);
      case 'RevokeACL': return await call('POST', '/api/v1/acl/revoke', fields);
      case 'DeleteACL': return await call('DELETE', '/api/v1/acl', fields);
      case 'ListExperienceTrajectories': case 'GetExperienceOutcomes': {
        const page = method === 'ListExperienceTrajectories' ? { limit: fields.limit, offset: fields.offset } : {};
        const path = method === 'ListExperienceTrajectories' ? 'trajectories' : 'outcomes';
        return await call('GET', `/api/v1/agent-evolution/experiences/${path}`, { ...page, experience_uri: target,
          start_date: fields.start_date || undefined, end_date: fields.end_date || undefined });
      }
      case 'AdminListAccounts': case 'AdminListAccountsWithOptions':
        return await call('GET', '/api/v1/admin/accounts', { name: fields.name || undefined, limit: fields.limit, page: fields.limit === undefined ? undefined : fields.page ?? 1 });
      case 'AdminDeleteAccount': return accountPath ? await call('DELETE', accountPath) : invalid();
      case 'AdminListUsers': case 'AdminListUsersWithOptions':
        return accountPath ? await call('GET', `${accountPath}/users`, { name: fields.name || undefined, role: fields.role, limit: fields.limit,
          page: fields.limit === undefined ? undefined : fields.page ?? 1 }) : invalid();
      case 'AdminRemoveUser': return userPath ? await call('DELETE', userPath) : invalid();
      case 'AdminSetRole': return userPath ? await call('PUT', `${userPath}/role`, { role: fields.role }) : invalid();
      case 'AdminMigrate': return await call('POST', '/api/v1/admin/migrate', { action: fields.cleanup ? 'cleanup' : 'migrate' });
      case 'AdminGetAgentEvolution': return await call('GET', '/api/v1/admin/agent-evolution');
      case 'AdminSetAgentEvolution': return await call('PUT', '/api/v1/admin/agent-evolution', fields);
      case 'AdminGetAccountSettings': return accountPath ? await call('GET', `${accountPath}/settings`) : invalid();
      case 'AdminSetAccountAgentEvolution': return accountPath
        ? await call('PATCH', `${accountPath}/settings`, { agent_evolution: { enabled: fields.enabled } }) : invalid();
      case 'WaitProcessed': return await call('POST', '/api/v1/system/wait', fields);
      case 'CheckConsistency': return await call('POST', '/api/v1/system/consistency', fields);
      case 'Health': return await call('GET', '/health');
      default: return forbidden();
    }
  } catch (error) {
    if (!mutates && isOpenVikingError(error) && error.statusCode && error.statusCode < 500)
      return fail(appError('openviking_request_failed', 'runtime', `OpenViking rejected the operation (HTTP ${error.statusCode}).`, error.statusCode === 429));
    return unknown();
  }
}
