import { expect, test } from 'bun:test';
import { openVikingManagement, type OpenVikingManagementMethod, type OpenVikingManagementRole } from '../../../packages/contracts/src/openviking-management.ts';
import { runOpenVikingManagement } from '../../../packages/core/src/openviking/management.ts';

const cases = [
  ['P', 'AddResource', 'POST', '/api/v1/resources', {"to":"viking://resources/imported","sourceUrl":"https://example.com/source.git","create_parent":false,"wait":false,"strict":false,"directly_upload_media":false,"preserve_structure":false,"watch_interval":0,"extra":{"add_type":"git","internal_task":false,"is_active":false,"source_name":"source.git"}}],
  ['P', 'Compile', 'POST', '/api/v1/compile', {"from":["viking://user/alice/memories"],"to":"viking://user/alice/memories","skill":"viking://user/alice/skills/compile","instruction":"","extra":{"reason":"Combine notes"}}],
  ['P', 'ResolveOpenVikingAssets', 'POST', '/api/v1/openviking-assets/resolve', {"manifest_yaml":"version: 1","catalog_yaml":"","manifest_label":""}],
  ['P', 'PreflightOpenVikingAsset', 'POST', '/api/v1/openviking-assets/preflight', {"name":"asset","repo_url":"https://example.com/git","branch":"main","commit":"","privateOptionsFromFile":true}],
  ['P', 'List', 'GET', '/api/v1/fs/ls', {"uri":"viking://user/alice/memories","include_overview":false,"limit":0}],
  ['P', 'ListPage', 'GET', '/api/v1/fs/ls', {"uri":"viking://user/alice/memories","include_overview":false,"limit":0}],
  ['P', 'Tree', 'GET', '/api/v1/fs/tree', {"uri":"viking://user/alice/memories","include_overview":false,"limit":0,"level_limit":0}],
  ['P', 'TreePage', 'GET', '/api/v1/fs/tree', {"uri":"viking://user/alice/memories","include_overview":false,"limit":0,"level_limit":0}],
  ['P', 'Stat', 'GET', '/api/v1/fs/stat', {"uri":"viking://user/alice/memories/item.md"}],
  ['P', 'Attrs', 'GET', '/api/v1/fs/attrs', {"uri":"viking://user/alice/memories/item.md"}],
  ['P', 'Mkdir', 'POST', '/api/v1/fs/mkdir', {"uri":"viking://user/alice/memories","acl":{"entries":null}}],
  ['P', 'Remove', 'DELETE', '/api/v1/fs', {"uri":"viking://user/alice/memories/item.md","wait":false,"recursive":false,"timeout":0}],
  ['P', 'Move', 'POST', '/api/v1/fs/mv', {"uri":"viking://user/alice/memories/item.md","to_uri":"viking://user/alice/memories/new.md"}],
  ['P', 'Read', 'GET', '/api/v1/content/read', {"uri":"viking://user/alice/memories/item.md","offset":0,"limit":-1}],
  ['P', 'DownloadBytes', 'GET', '/api/v1/content/download', {"uri":"viking://user/alice/memories/item.md"}],
  ['P', 'Abstract', 'GET', '/api/v1/content/abstract', {"uri":"viking://user/alice/memories/item.md"}],
  ['P', 'Overview', 'GET', '/api/v1/content/overview', {"uri":"viking://user/alice/memories/item.md"}],
  ['P', 'Write', 'POST', '/api/v1/content/write', {"uri":"viking://user/alice/memories/item.md","content":"","mode":"","wait":false,"processing_mode":"","tags":[],"tag_mode":""}],
  ['P', 'BatchWrite', 'POST', '/api/v1/content/batch-write', {"uri":"viking://user/alice/memories","operations":[{"uri":"viking://user/alice/memories/item.md","content":"","mode":"upsert"}],"wait":false,"timeout":0,"telemetry":false}],
  ['P', 'SetTags', 'POST', '/api/v1/fs/attrs/set_tags', {"uri":"viking://user/alice/memories/item.md","tags":null,"mode":"clear","recursive":false}],
  ['P', 'Reindex', 'POST', '/api/v1/content/reindex', {"uri":"viking://user/alice/memories/item.md","wait":false,"recursive":false,"tags":[]}],
  ['P', 'Find', 'POST', '/api/v1/search/find', {"query":"","target_uri":"viking://user/alice/memories","image_url":"https://example.com/image.png","node_limit":0,"filter":null}],
  ['P', 'Search', 'POST', '/api/v1/search/search', {"query":"q","target_uri":"viking://user/alice/memories","search_type":"","time_field":"","read_content":false}],
  ['P', 'SearchContext', 'POST', '/api/v1/search/search', {"query":"q","max_tokens":64,"dedup_turns":2,"context_type":["memory","resource"],"other_peer_penalty":{"agent":0}}],
  ['P', 'Grep', 'POST', '/api/v1/search/grep', {"uri":"viking://user/alice/memories","pattern":"abc","case_insensitive":false}],
  ['P', 'Glob', 'POST', '/api/v1/search/glob', {"uri":"viking://user/alice/memories","pattern":"*.md","node_limit":0}],
  ['P', 'CreateSession', 'POST', '/api/v1/sessions', {"sessionId":"flowmate-management-s1","disableAutoCommit":true}],
  ['P', 'ListSessions', 'GET', '/api/v1/sessions', {}],
  ['P', 'GetSession', 'GET', '/api/v1/sessions/flowmate-management-s1', {"sessionId":"flowmate-management-s1","auto_create":false}],
  ['P', 'UpdateSessionConfig', 'PATCH', '/api/v1/sessions/flowmate-management-s1/config', {"sessionId":"flowmate-management-s1","auto_commit_policy":null,"memory_extraction_config":null,"telemetry":false}],
  ['P', 'SessionExists', 'GET', '/api/v1/sessions/flowmate-management-s1', {"sessionId":"flowmate-management-s1"}],
  ['P', 'GetSessionContext', 'GET', '/api/v1/sessions/flowmate-management-s1/context', {"sessionId":"flowmate-management-s1","token_budget":0}],
  ['P', 'GetSessionArchive', 'GET', '/api/v1/sessions/flowmate-management-s1/archives/archive_001', {"sessionId":"flowmate-management-s1","archiveId":"archive_001"}],
  ['P', 'DeleteSession', 'DELETE', '/api/v1/sessions/flowmate-management-s1', {"sessionId":"flowmate-management-s1"}],
  ['P', 'AddMessage', 'POST', '/api/v1/sessions/flowmate-management-s1/messages', {"sessionId":"flowmate-management-s1","role":"user","content":"","source_message_ids":[]}],
  ['P', 'BatchAddMessages', 'POST', '/api/v1/sessions/flowmate-management-s1/messages/batch', {"sessionId":"flowmate-management-s1","messages":[{"role":"user","content":"sample","telemetry":false}]}],
  ['P', 'CommitSession', 'POST', '/api/v1/sessions/flowmate-management-s1/commit', {"sessionId":"flowmate-management-s1","keep_recent_count":0,"retention_mode":"","eventTags":[],"extra":{"reset_context":false}}],
  ['P', 'GetTask', 'GET', '/api/v1/tasks/t1', {"taskId":"t1"}],
  ['P', 'CancelTask', 'POST', '/api/v1/tasks/t1/cancel', {"taskId":"t1"}],
  ['P', 'ListTasks', 'GET', '/api/v1/tasks', {"limit":0}],
  ['P', 'AddSkill', 'POST', '/api/v1/skills', {"wait":false,"target_uri":["viking://user/alice/skills"],"extra":{"skills":["demo"],"list_only":false}}],
  ['P', 'ListSkills', 'GET', '/api/v1/skills', {"node_limit":0,"target_uri":["viking://user/alice/skills"]}],
  ['P', 'FindSkills', 'POST', '/api/v1/skills/find', {"query":"sample","limit":0,"target_uri":"viking://user/alice/skills"}],
  ['P', 'ValidateSkill', 'POST', '/api/v1/skills/validate', {"data":"---\nname: skill\n---\n# skill","strict":false,"source_path":"SKILL.md","skill_dir_name":"skill"}],
  ['P', 'GetSkill', 'GET', '/api/v1/skills/skill', {"skillName":"skill","include_files":false,"include_content":false}],
  ['P', 'UpdateSkill', 'PUT', '/api/v1/skills/skill', {"skillName":"skill","wait":false,"extra":{"from_source":true}}],
  ['P', 'DeleteSkill', 'DELETE', '/api/v1/skills/skill', {"skillName":"skill","target_uri":"viking://user/alice/memories"}],
  ['P', 'ListWatches', 'GET', '/api/v1/watches', {"to_uri":"viking://user/alice/memories","active_only":false}],
  ['P', 'GetWatch', 'GET', '/api/v1/watches/w1', {"taskId":"w1","to_uri":"viking://user/alice/memories"}],
  ['P', 'UpdateWatch', 'PATCH', '/api/v1/watches/w1', {"taskId":"w1","to_uri":"viking://user/alice/memories","is_active":false,"watch_interval":0}],
  ['P', 'DeleteWatch', 'DELETE', '/api/v1/watches', {"to_uri":"viking://user/alice/memories"}],
  ['P', 'TriggerWatch', 'POST', '/api/v1/watches/w1/trigger', {"taskId":"w1","to_uri":"viking://user/alice/memories"}],
  ['P', 'ExportOVPack', 'POST', '/api/v1/pack/export', {"uri":"viking://user/alice/memories","include_vectors":false}],
  ['S', 'BackupOVPack', 'POST', '/api/v1/pack/backup', {"include_vectors":false}],
  ['P', 'ImportOVPack', 'POST', '/api/v1/pack/import', {"uri":"viking://user/alice/memories","on_conflict":"skip","vector_mode":"auto"}],
  ['S', 'RestoreOVPack', 'POST', '/api/v1/pack/restore', {"on_conflict":"skip","vector_mode":""}],
  ['P', 'ACL', 'GET', '/api/v1/acl', {"uri":"viking://user/alice/memories/item.md"}],
  ['A', 'SetACL', 'PUT', '/api/v1/acl', {"uri":"viking://user/alice/memories/item.md","entries":null,"acl_mode":"restricted"}],
  ['P', 'SetACLMode', 'PUT', '/api/v1/acl', {"uri":"viking://user/alice/memories/item.md","acl_mode":"inherit"}],
  ['P', 'GrantACL', 'POST', '/api/v1/acl/grant', {"uri":"viking://user/alice/memories/item.md","principal":"user:bob","level":"read"}],
  ['P', 'RevokeACL', 'POST', '/api/v1/acl/revoke', {"uri":"viking://user/alice/memories/item.md","principal":"user:bob"}],
  ['P', 'DeleteACL', 'DELETE', '/api/v1/acl', {"uri":"viking://user/alice/memories/item.md"}],
  ['S', 'AdminCreateAccount', 'POST', '/api/v1/admin/accounts', {"accountId":"account","adminUserId":"alice"}],
  ['S', 'AdminCreateAccountWithOptions', 'POST', '/api/v1/admin/accounts', {"accountId":"account","adminUserId":"alice","privateOptionsFromFile":true}],
  ['S', 'AdminListAccounts', 'GET', '/api/v1/admin/accounts', {}],
  ['S', 'AdminListAccountsWithOptions', 'GET', '/api/v1/admin/accounts', {"limit":0,"page":0,"name":"acc*"}],
  ['S', 'AdminDeleteAccount', 'DELETE', '/api/v1/admin/accounts/account', {"accountId":"account"}],
  ['A', 'AdminRegisterUser', 'POST', '/api/v1/admin/accounts/account/users', {"userId":"alice","role":""}],
  ['A', 'AdminRegisterUserWithOptions', 'POST', '/api/v1/admin/accounts/account/users', {"userId":"alice","role":"user","privateOptionsFromFile":true}],
  ['A', 'AdminListUsers', 'GET', '/api/v1/admin/accounts/account/users', {}],
  ['A', 'AdminListUsersWithOptions', 'GET', '/api/v1/admin/accounts/account/users', {"limit":0,"page":0,"role":"user"}],
  ['A', 'AdminRemoveUser', 'DELETE', '/api/v1/admin/accounts/account/users/alice', {"userId":"alice"}],
  ['A', 'AdminSetRole', 'PUT', '/api/v1/admin/accounts/account/users/alice/role', {"userId":"alice","role":"user"}],
  ['A', 'AdminRegenerateKey', 'POST', '/api/v1/admin/accounts/account/users/alice/key', {"userId":"alice"}],
  ['A', 'AdminRegenerateKeyWithOptions', 'POST', '/api/v1/admin/accounts/account/users/alice/key', {"userId":"alice","privateOptionsFromFile":true}],
  ['S', 'AdminMigrate', 'POST', '/api/v1/admin/migrate', {"cleanup":false}],
  ['A', 'AdminCreateGroup', 'POST', '/api/v1/admin/accounts/account/groups', {"groupId":"team"}],
  ['A', 'AdminListGroups', 'GET', '/api/v1/admin/accounts/account/groups', {}],
  ['A', 'AdminDeleteGroup', 'DELETE', '/api/v1/admin/accounts/account/groups/team', {"groupId":"team"}],
  ['A', 'AdminListGroupMembers', 'GET', '/api/v1/admin/accounts/account/groups/team/members', {"groupId":"team"}],
  ['A', 'AdminAddGroupMember', 'PUT', '/api/v1/admin/accounts/account/groups/team/members/alice', {"groupId":"team","userId":"alice"}],
  ['A', 'AdminRemoveGroupMember', 'DELETE', '/api/v1/admin/accounts/account/groups/team/members/alice', {"groupId":"team","userId":"alice"}],
  ['A', 'AdminGetAgentEvolution', 'GET', '/api/v1/admin/agent-evolution', {}],
  ['A', 'AdminSetAgentEvolution', 'PUT', '/api/v1/admin/agent-evolution', {"enabled":false}],
  ['A', 'AdminGetAccountSettings', 'GET', '/api/v1/admin/accounts/account/settings', {}],
  ['A', 'AdminSetAccountAgentEvolution', 'PATCH', '/api/v1/admin/accounts/account/settings', {"enabled":false}],
  ['S', 'WaitProcessed', 'POST', '/api/v1/system/wait', {"timeout":0}],
  ['S', 'CheckConsistency', 'POST', '/api/v1/system/consistency', {"uri":"viking://user/alice/memories"}],
  ['A', 'Health', 'GET', '/health', {}],
  ['S', 'QueueStatus', 'GET', '/api/v1/observer/queue', {"format":"table"}],
  ['S', 'VikingDBStatus', 'GET', '/api/v1/observer/vikingdb', {"format":"json"}],
  ['S', 'ModelsStatus', 'GET', '/api/v1/observer/models', {"format":"json"}],
  ['S', 'GetStatus', 'GET', '/api/v1/observer/system', {"format":""}],
  ['S', 'IsHealthy', 'GET', '/api/v1/observer/system', {}],
  ['P', 'ListExperienceTrajectories', 'GET', '/api/v1/agent-evolution/experiences/trajectories', {"uri":"viking://user/alice/memories/item.md","limit":0,"offset":0}],
  ['P', 'GetExperienceOutcomes', 'GET', '/api/v1/agent-evolution/experiences/outcomes', {"uri":"viking://user/alice/memories/item.md","start_date":"2026-11-06","end_date":""}],
] as const;

const listOptions = { include_overview: 'false', limit: null, output: 'original', abs_limit: '256' };
const treeOptions = { ...listOptions, abs_limit: '128', level_limit: '0' };
const adminPagination = { limit: '0', page: '0' };
const optionQueries: Partial<Record<OpenVikingManagementMethod, Record<string, string | null>>> = {
  List: listOptions, ListPage: listOptions, Tree: treeOptions, TreePage: treeOptions,
  Remove: { wait: 'false', recursive: 'false', timeout: '0' },
  GetSession: { auto_create: null },
  ListTasks: { limit: null },
  ListSkills: { target_uri: 'viking://user/alice/skills', node_limit: '1000' },
  GetSkill: { include_files: 'false', include_content: 'false', include_source: 'false' },
  DeleteSkill: { target_uri: 'viking://user/alice/memories' },
  ListWatches: { to_uri: 'viking://user/alice/memories', active_only: 'false' },
  UpdateWatch: { to_uri: 'viking://user/alice/memories' },
  AdminListAccountsWithOptions: { ...adminPagination, name: 'acc*' },
  AdminListUsersWithOptions: { ...adminPagination, role: 'user' },
  QueueStatus: { format: 'table' }, VikingDBStatus: { format: 'json' }, ModelsStatus: { format: 'json' }, GetStatus: { format: null },
  ListExperienceTrajectories: { experience_uri: 'viking://user/alice/memories/item.md', limit: '0', offset: '0' },
  GetExperienceOutcomes: { experience_uri: 'viking://user/alice/memories/item.md', start_date: '2026-11-06', end_date: null },
};

const optionBodies: Partial<Record<OpenVikingManagementMethod, Record<string, unknown>>> = {
  Write: { content: '', mode: 'replace', wait: false, tags: [], tag_mode: 'replace' },
  SetTags: { tags: [], mode: 'clear', recursive: false },
  Reindex: { mode: 'vectors_only', wait: false, recursive: false, tags: [], tag_mode: 'replace' },
  Search: { read_content: false, limit: 10 },
  Grep: { case_insensitive: false },
  Glob: { node_limit: 0 },
  AddMessage: { role: 'user', content: '', source_message_ids: [] },
  FindSkills: { limit: 10, target_uri: 'viking://user/alice/skills' },
  ExportOVPack: { include_vectors: false }, BackupOVPack: { include_vectors: false },
  ImportOVPack: { parent: 'viking://user/alice/memories', temp_file_id: 'upload-1', on_conflict: 'skip', vector_mode: 'auto' },
  SetACL: { entries: [], acl_mode: 'restricted' },
  AdminCreateAccountWithOptions: { seed: 'private-seed' },
  AdminRegisterUser: { role: 'user' },
  AdminRegisterUserWithOptions: { seed: 'private-seed', role: 'user' },
  AdminRegenerateKeyWithOptions: { seed: 'private-seed' },
  AdminMigrate: { action: 'migrate' },
};

test('all 96 management operations have one explicit wire contract', () => {
  expect(cases).toHaveLength(96);
  expect(Object.keys(openVikingManagement).sort()).toEqual(cases.map(row => row[1]).sort());
});

test('legacy SearchContext booleans map to integer deduplication windows', () => {
  const schema = openVikingManagement.SearchContext.input;
  expect(schema.parse({ query: 'q', dedup_turns: false }).dedup_turns).toBe(0);
  expect(schema.parse({ query: 'q', dedup_turns: true }).dedup_turns).toBe(1);
  expect(schema.safeParse({ query: 'q', dedup_turns: 101 }).success).toBe(false);
});

const endpoint = 'http://127.0.0.1:19338';
const identities = {
  P: { role: 'P', endpoint, apiKey: 'p-test-key', accountId: 'account', userId: 'alice', peerId: 'flowmate' },
  A: { role: 'A', endpoint, apiKey: 'a-test-key', accountId: 'account', userId: 'alice' },
  S: { role: 'S', endpoint, apiKey: 's-test-key' },
} as const;

test('named Go Extra fields cannot widen the caller scope or override typed options', async () => {
  const forbidden = [
    ['SearchContext', { query: 'q', extra: { target_uri: 'viking://user/alice/memories' } }, 'input_invalid'],
    ['SearchContext', { query: 'q', extra: { session_id: 'other' } }, 'input_invalid'],
    ['AddResource', { sourceUrl: 'https://example.com/source.md', add_type: 'auto', extra: { add_type: 'alternate' } }, 'input_invalid'],
    ['Compile', { from: [], to: 'viking://user/alice/memories', skill: 'viking://user/bob/skills/compile' }, 'memory_scope_denied'],
    ['CommitSession', { sessionId: 'flowmate-management-s1', eventTags: [], extra: { extraction_metadata: { event: null } } }, 'input_invalid'],
    ['UpdateSkill', { skillName: 'skill', data: { name: 'skill' }, extra: { from_source: true } }, 'input_invalid'],
  ] as const;
  let dispatched = 0;
  const transport = (async (_resource: RequestInfo | URL) => {
    dispatched++;
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  for (const [method, input, code] of forbidden) {
    const result = await runOpenVikingManagement(identities.P, { connectionId: crypto.randomUUID(), method, input },
      async () => true, transport);
    expect(result).toMatchObject({ ok: false, error: { code } });
  }
  expect(dispatched).toBe(0);
});

const binary = new Set(['DownloadBytes', 'ExportOVPack', 'BackupOVPack']);
const issuesKey = /^(AdminCreateAccount|AdminRegisterUser|AdminRegenerateKey)(WithOptions)?$/;
const arrays = new Set(['List', 'ListPage', 'Tree', 'TreePage', 'AdminListGroups', 'AdminListAccounts', 'AdminListAccountsWithOptions', 'AdminListUsers', 'AdminListUsersWithOptions', 'ListTasks', 'ListSessions']);
const texts = new Set(['Read', 'Abstract', 'Overview']);

for (const [role, method, verb, path, input] of cases) test(`${role} ${method} uses its fixed server route`, async () => {
  const requests: { path: string; verb: string; query: URLSearchParams; body: unknown }[] = [];
  let saved = '', confirmed = 0;
  const transport = (async (resource: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(resource)), key = new Headers(init?.headers).get('X-API-Key');
    expect(url.origin).toBe(endpoint);
    expect(key).toBe(identities[role].apiKey);
    expect(init?.redirect).toBe('error');
    if (url.pathname === '/health') {
      const roleName = { P: 'user', A: 'admin', S: 'root' }[role];
      return Response.json({ status: 'ok', version: '0.4.23', auth_mode: 'api_key', role: roleName, account_id: 'account', user_id: 'alice' });
    }
    if (url.pathname === '/api/v1/resources/temp_upload') {
      expect(init?.body).toBeInstanceOf(FormData);
      return Response.json({ status: 'ok', result: { temp_file_id: 'upload-1' } });
    }
    requests.push({ path: url.pathname, verb: init?.method ?? 'GET', query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
    if (binary.has(method)) return new Response('raw bytes', { headers: { 'Content-Type': 'application/octet-stream' } });
    return Response.json({ status: 'ok', result: issuesKey.test(method) ? { user_key: 'issued-private-key' }
      : arrays.has(method) ? [] : texts.has(method) ? 'fixture' : { is_healthy: true }, has_more: false });
  }) as typeof fetch;
  const call = (roleName: OpenVikingManagementRole) => runOpenVikingManagement(identities[roleName],
    { connectionId: crypto.randomUUID(), method, input }, async () => { confirmed++; return true; }, transport, {
      selectUpload: async () => ({ body: new Blob(['example']), name: 'test.txt' }),
      selectOutput: async () => async data => { saved = await new Response(data).text(); },
      selectPrivateOptions: async () => method === 'PreflightOpenVikingAsset'
        ? { username: '', token: 'private-token' } : { seed: 'private-seed' },
    });
  const result = await call(role);
  expect(result).toMatchObject({ ok: true });
  if (method !== 'Health') expect(requests.map(item => [item.verb, item.path])).toEqual([[verb, path]]);
  expect(confirmed).toBe(openVikingManagement[method].mutates ? 1 : 0);
  if (binary.has(method)) expect(saved).toBe('raw bytes');
  if (issuesKey.test(method)) {
    expect(saved).toContain('issued-private-key');
    expect(JSON.stringify(result)).not.toContain('issued-private-key');
  }
  for (const [parameter, expected] of Object.entries(optionQueries[method] ?? {}))
    expect(requests[0]?.query.getAll(parameter)).toEqual(expected === null ? [] : [expected]);
  const expectedBody = optionBodies[method];
  if (expectedBody) expect(requests[0]?.body).toMatchObject(expectedBody);
  if (method === 'CreateSession') expect(requests[0]?.body).toMatchObject({ auto_commit_policy: null });
  if (method === 'Find') expect(requests[0]?.body).toEqual({ query: '', target_uri: 'viking://user/alice/memories',
    image_url: 'https://example.com/image.png', limit: 0, filter: null });
  if (method === 'SearchContext') expect(requests[0]?.body).toMatchObject({ mode: 'context', max_tokens: 64, dedup_turns: 2,
    context_type: ['memory', 'resource'], other_peer_penalty: { agent: 0 } });
  if (method === 'AddResource') expect(requests[0]?.body).toMatchObject({ add_type: 'git', internal_task: false, is_active: false,
    create_parent: false, wait: false, directly_upload_media: false, preserve_structure: false,
    watch_interval: 0, path: 'https://example.com/source.git', source_name: 'source.git' });
  if (method === 'Compile') expect(requests[0]?.body).toEqual({ from: ['viking://user/alice/memories'],
    to: 'viking://user/alice/memories', skill: 'viking://user/alice/skills/compile', instruction: 'Combine notes' });
  if (method === 'ResolveOpenVikingAssets') expect(requests[0]?.body).toEqual({ manifest_yaml: 'version: 1' });
  if (method === 'PreflightOpenVikingAsset') {
    expect(requests[0]?.body).toEqual({ name: 'asset', repo_url: 'https://example.com/git',
      connector: 'git', branch: 'main', auth_config: { token: 'private-token' } });
    expect(JSON.stringify(result)).not.toContain('private-token');
  }
  if (method === 'BatchWrite') expect(requests[0]?.body).toEqual({ root_uri: 'viking://user/alice/memories',
    operations: [{ uri: 'viking://user/alice/memories/item.md', content: '', mode: 'upsert' }], wait: false, timeout: 0, telemetry: false });
  if (method === 'BatchAddMessages') expect(requests[0]?.body).toEqual({ messages: [{ role: 'user', content: 'sample', telemetry: false }] });
  if (method === 'UpdateSessionConfig') expect(requests[0]?.body).toEqual({
    auto_commit_policy: null, memory_extraction_config: null, telemetry: false });
  if (method === 'CommitSession') expect(requests[0]?.body).toEqual({ keep_recent_count: 0, reset_context: false,
    extraction_metadata: { event: { tags: [] } } });
  if (method === 'Write') expect(requests[0]?.body).not.toHaveProperty('processing_mode');
  if (method === 'Search') {
    expect(requests[0]?.body).not.toHaveProperty('search_type');
    expect(requests[0]?.body).not.toHaveProperty('time_field');
  }
  if (method === 'AddSkill') expect(requests[0]?.body).toEqual({ target_uri: 'viking://user/alice/skills',
    skills: ['demo'], list_only: false, wait: false, temp_file_id: 'upload-1' });
  if (method === 'ValidateSkill') expect(requests[0]?.body).toMatchObject({ data: '---\nname: skill\n---\n# skill',
    strict: false, source_path: 'SKILL.md', skill_dir_name: 'skill' });
  if (method === 'UpdateSkill') expect(requests[0]?.body).toEqual({ from_source: true, wait: false });
  if (method === 'RestoreOVPack') expect(requests[0]?.body).toEqual({ temp_file_id: 'upload-1', on_conflict: 'skip' });
  if (method === 'UpdateWatch') expect(requests[0]?.body).toMatchObject({ is_active: false, watch_interval: 0 });
  if (method === 'WaitProcessed') expect(requests[0]?.body).toEqual({ timeout: 0 });
  if (method === 'AdminSetAccountAgentEvolution') expect(requests[0]?.body).toEqual({ agent_evolution: { enabled: false } });
});
