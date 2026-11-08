import { z } from 'zod';
import { MemoryEndpointSchema } from './openviking-memory.ts';
import type { Result } from './runtime.ts';

const name = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
const text = z.string().max(4096);
const optionalText = text.optional().transform(value => value || undefined);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uri = text.min(1);
const pagination = { name: text.optional(), limit: count.optional(), page: count.optional() };
const role = z.enum(['user', 'admin']);
const optionalRole = role.or(z.literal('')).optional().transform(value => value || undefined);
const account = { accountId: name.optional() };
const user = { ...account, userId: name };
const group = { groupId: name };
const display = { format: z.enum(['', 'json', 'table']).optional() };
const tree = {
  uri, output: text.optional(), abs_limit: count.optional(), overview_limit: count.optional(),
  include_abstract: z.boolean().optional(), include_overview: z.boolean().optional(),
  show_all_hidden: z.boolean().optional(), node_limit: count.optional(),
  offset: count.optional(), limit: count.optional(), extra_fields: z.array(text).max(100).optional(),
  tags: z.array(text).max(100).optional(), include_tags: z.boolean().optional(),
};
const list = { ...tree, simple: z.boolean().optional(), recursive: z.boolean().optional(), sort_by: optionalText, sort_order: optionalText };
const treePage = { ...tree, directories_only: z.boolean().optional(), level_limit: z.number().int().min(-1).max(1000).optional() };
const tags = z.array(text).max(100);
const tagMode = z.enum(['', 'replace', 'append', 'clear']).optional().transform(value => value || undefined);
const writeModes = ['create', 'replace', 'append'] as const;
const timeout = z.number().finite().min(0).max(300).optional();
const aclMode = z.enum(['inherit', 'restricted']);
const optionalAclMode = aclMode.or(z.literal('')).optional().transform(value => value || undefined);
const aclLevel = z.enum(['read', 'write', 'manage']);
const principal = z.string().min(1).max(256);
const entries = z.array(z.object({ principal, level: aclLevel }).strict()).max(200);
const acl = z.object({ acl_mode: optionalAclMode, entries: entries.nullable().optional() }).strict();
const json = z.record(z.unknown());
const contextType = text.or(z.array(text).max(20)).nullable().optional();
const retrievalTarget = uri.or(z.array(uri).min(1).max(20)).optional();
const retrievalLevel = z.array(count).max(10).optional();
const extractionMetadata = z.object({
  event: z.object({ tags: tags.nullable().optional() }).strict().nullable().optional(),
}).strict();
const session = { sessionId: name };
const managedSessionId = name.regex(/^flowmate-management-/);
const managedSession = { sessionId: managedSessionId };
const autoCommit = json.nullable().optional();
const message = {
  role: z.enum(['user', 'assistant']), content: z.string().max(65000).optional(), parts: z.array(json).min(1).max(50).optional(),
  created_at: optionalText, peer_id: name.optional(), turn_id: name.optional(), message_kind: optionalText,
  source_message_ids: z.array(text).max(100).optional(), telemetry: z.unknown().optional(),
};
const recall = {
  query: z.string().max(4096), target_uri: retrievalTarget,
  limit: count.optional(), node_limit: count.optional(), score_threshold: z.number().finite().optional(),
  filter: json.nullable().optional(), context_type: contextType, include_provenance: z.boolean().optional(), read_content: z.boolean().optional(),
  since: optionalText, until: optionalText, time_field: optionalText, events_time_decay_protection: optionalText,
  level: retrievalLevel, tags: tags.optional(), telemetry: z.unknown().optional(),
  image_url: text.optional(), imageFromFile: z.boolean().optional(),
};
const experience = { uri, start_date: text.optional(), end_date: text.optional() };
const target = uri.or(z.tuple([uri]).transform(([value]) => value)).optional();
const skill = { skillName: name, target_uri: target };
const skillData = { data: json.optional(), wait: z.boolean().optional(), timeout, telemetry: z.unknown().optional() };
const watch = { taskId: name.optional(), to_uri: uri.optional() };
const importOptions = { on_conflict: z.enum(['', 'fail', 'overwrite', 'skip']).optional(),
  vector_mode: z.enum(['', 'auto', 'recompute', 'require']).optional() };
const privateOptions = { privateOptionsFromFile: z.boolean().optional() };
const resourceOptions = {
  to: uri.optional(), parent: uri.optional(), create_parent: z.boolean().optional(), add_type: optionalText,
  reason: text.optional(), instruction: text.optional(), wait: z.boolean().optional(), timeout, strict: z.boolean().optional(),
  directly_upload_media: z.boolean().optional(), watch_interval: z.number().finite().min(0).optional(),
  ignore_dirs: optionalText, include: optionalText, exclude: optionalText, preserve_structure: z.boolean().optional(),
  processing_mode: optionalText, telemetry: z.unknown().optional(), args: json.optional(), acl: acl.optional(),
  tags: tags.optional(), tag_mode: tagMode, sourceUrl: text.optional(),
  ...privateOptions,
  extra: z.object({ add_type: text.optional(), internal_task: z.boolean().optional(), is_active: z.boolean().optional(),
    source_name: z.string().min(1).max(255).refine(value => value !== '.' && value !== '..' && !/[\\/:\u0000-\u001f]/.test(value)).optional(),
  }).strict().optional(),
};

export const OpenVikingManagementRoleSchema = z.enum(['P', 'A', 'S']);
export type OpenVikingManagementRole = z.infer<typeof OpenVikingManagementRoleSchema>;
function operation<Fields extends z.ZodRawShape>(roles: readonly OpenVikingManagementRole[], fields: Fields, mutates = false) {
  return { roles, input: z.object(fields).strict(), mutates };
}

export const openVikingManagement = {
  AddResource: operation(['P'], resourceOptions, true),
  Compile: operation(['P'], { from: z.array(uri).max(100), to: uri, skill: name.or(uri.refine(value => value.startsWith('viking://'))),
    instruction: text.optional(), args: json.optional(), extra: z.object({ reason: text.optional() }).strict().optional() }, true),
  ResolveOpenVikingAssets: operation(['P'], { manifest_yaml: z.string().max(65000), catalog_yaml: z.string().max(65000).optional(),
    manifest_label: text.optional(), catalog_label: text.optional() }),
  PreflightOpenVikingAsset: operation(['P'], { name, repo_url: text.min(1), branch: text.optional(), commit: text.optional(), ...privateOptions }),
  List: operation(['P'], list),
  ListPage: operation(['P'], list),
  Tree: operation(['P'], treePage),
  TreePage: operation(['P'], treePage),
  Stat: operation(['P'], { uri }),
  Attrs: operation(['P'], { uri }),
  Read: operation(['P'], { uri, offset: count, limit: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER) }),
  DownloadBytes: operation(['P'], { uri }),
  Abstract: operation(['P'], { uri }),
  Overview: operation(['P'], { uri }),
  Mkdir: operation(['P'], { uri, description: text.optional(), acl: acl.optional() }, true),
  Remove: operation(['P'], { uri, recursive: z.boolean().optional(), wait: z.boolean().optional(), timeout }, true),
  Move: operation(['P'], { uri, to_uri: uri }, true),
  Write: operation(['P'], { uri, content: z.string().max(65000), mode: z.enum(['', ...writeModes]).optional().transform(value => value || undefined),
    wait: z.boolean().optional(), timeout, telemetry: z.unknown().optional(), processing_mode: optionalText,
    acl: acl.optional(), tags: tags.optional(), tag_mode: tagMode }, true),
  BatchWrite: operation(['P'], { uri, operations: z.array(z.object({ uri, content: z.string().max(65000).optional(),
    content_base64: z.string().max(90000).optional(),
    mode: z.enum(['', ...writeModes, 'upsert']).optional().transform(value => value || undefined) }).strict()).min(1).max(50),
    wait: z.boolean().optional(), timeout, telemetry: z.unknown().optional() }, true),
  SetTags: operation(['P'], { uri, tags: tags.nullable().optional(), mode: tagMode,
    recursive: z.boolean().optional(), telemetry: z.unknown().optional() }, true),
  Reindex: operation(['P'], { uri, mode: optionalText, wait: z.boolean().optional(), force: z.boolean().optional(),
    recursive: z.boolean().optional(), tags: tags.optional(), tag_mode: tagMode }, true),
  Find: operation(['P'], recall),
  Search: operation(['P'], { ...recall, search_type: optionalText, session_id: name.optional() }),
  SearchContext: operation(['P'], { query: recall.query, search_type: optionalText, session_id: name.optional(),
    limit: count.optional(), node_limit: count.optional(), score_threshold: z.number().finite().optional(), filter: json.nullable().optional(),
    context_type: contextType, include_provenance: z.boolean().optional(), tags: tags.optional(), since: optionalText, until: optionalText,
    time_field: optionalText, events_time_decay_protection: optionalText, query_expansion: optionalText,
    max_tokens: count.optional(), quotas: json.optional(), purpose: optionalText, detail: z.unknown().optional(),
    dedup_turns: count.max(100).or(z.boolean()).transform(value => Number(value)).optional(),
    exclude_uris: z.array(uri).max(100).optional(), peer_scope: optionalText,
    other_peer_penalty: z.number().finite().or(z.record(z.number().finite())).nullable().optional(),
    rewrite: z.unknown().optional(), rewrite_max_bullets: count.optional(),
    telemetry: z.unknown().optional(), image_url: text.optional(), imageFromFile: z.boolean().optional() }),
  Grep: operation(['P'], { uri, pattern: text.min(1), case_insensitive: z.boolean().optional(), node_limit: count.optional(),
    level_limit: z.number().int().min(-1).max(1000).optional(), exclude_uri: uri.optional(), tags: tags.optional(), include_tags: z.boolean().optional() }),
  Glob: operation(['P'], { uri, pattern: text.min(1), node_limit: count.optional(), tags: tags.optional(), include_tags: z.boolean().optional() }),
  CreateSession: operation(['P'], { sessionId: managedSessionId.optional(), memory_policy: json.nullable().optional(), disableAutoCommit: z.boolean().optional(),
    auto_commit_policy: autoCommit, memory_extraction_config: json.nullable().optional(), telemetry: z.unknown().optional() }, true),
  ListSessions: operation(['P'], {}),
  GetSession: operation(['P'], { ...session, auto_create: z.boolean().optional() }),
  UpdateSessionConfig: operation(['P'], { ...managedSession, auto_commit_policy: autoCommit,
    memory_extraction_config: json.nullable().optional(), telemetry: z.unknown().optional() }, true),
  SessionExists: operation(['P'], session),
  GetSessionContext: operation(['P'], { ...session, token_budget: count.optional() }),
  GetSessionArchive: operation(['P'], { ...session, archiveId: name }),
  DeleteSession: operation(['P'], managedSession, true),
  AddMessage: operation(['P'], { ...managedSession, ...message }, true),
  BatchAddMessages: operation(['P'], { ...managedSession, messages: z.array(z.object(message).strict()).min(1).max(100),
    telemetry: z.unknown().optional() }, true),
  CommitSession: operation(['P'], { ...managedSession, keep_recent_count: count.optional(), retention_mode: optionalText,
    keep_recent_turn_count: count.optional(), retained_message_token_budget: count.optional(), min_raw_tail_steps: count.optional(),
    eventTags: tags.optional(), telemetry: z.unknown().optional(),
    extra: z.object({ reset_context: z.boolean().optional(), extraction_metadata: extractionMetadata.nullable().optional() }).strict().optional() }, true),
  GetTask: operation(['P'], { taskId: name }),
  CancelTask: operation(['P'], { taskId: name }, true),
  ListTasks: operation(['P'], { task_type: text.optional(), status: text.optional(), resource_id: text.optional(), limit: count.optional() }),
  AddSkill: operation(['P'], { ...skillData, target_uri: target,
    extra: z.object({ list_only: z.boolean().optional(), source_metadata: json.optional(),
      skills: z.array(name).max(100).or(z.tuple([z.literal('*')])).optional() }).strict().optional() }, true),
  ListSkills: operation(['P'], { node_limit: count.optional(), target_uri: target }),
  FindSkills: operation(['P'], { query: recall.query.min(1), limit: count.optional(), score_threshold: z.number().finite().optional(),
    level: z.array(count).max(10).optional(), telemetry: z.unknown().optional(), target_uri: target }),
  ValidateSkill: operation(['P'], { data: json.or(z.string().max(65000)), strict: z.boolean().optional(), source_path: text.optional(), skill_dir_name: name.optional(), target_uri: target }),
  GetSkill: operation(['P'], { ...skill, include_content: z.boolean().optional(), include_files: z.boolean().optional(),
    include_source: z.boolean().optional(), level: count.optional() }),
  UpdateSkill: operation(['P'], { ...skill, ...skillData, source_metadata: json.optional(),
    extra: z.object({ from_source: z.boolean().optional() }).strict().optional() }, true),
  DeleteSkill: operation(['P'], skill, true),
  ListWatches: operation(['P'], { to_uri: uri.optional(), active_only: z.boolean().optional() }),
  GetWatch: operation(['P'], { taskId: name, to_uri: uri.optional() }),
  UpdateWatch: operation(['P'], { ...watch, watch_interval: z.number().finite().min(0).optional(),
    is_active: z.boolean().optional(), reason: text.optional(), instruction: text.optional() }, true),
  DeleteWatch: operation(['P'], watch, true),
  TriggerWatch: operation(['P'], watch, true),
  ExportOVPack: operation(['P', 'A', 'S'], { uri, include_vectors: z.boolean().optional() }),
  BackupOVPack: operation(['S'], { include_vectors: z.boolean().optional() }),
  ImportOVPack: operation(['P', 'A', 'S'], { uri, ...importOptions }, true),
  RestoreOVPack: operation(['S'], importOptions, true),
  ACL: operation(['P', 'A'], { uri }),
  SetACL: operation(['P', 'A'], { uri, entries: entries.nullable().optional(), acl_mode: optionalAclMode }, true),
  SetACLMode: operation(['P', 'A'], { uri, acl_mode: aclMode }, true),
  GrantACL: operation(['P', 'A'], { uri, principal, level: aclLevel }, true),
  RevokeACL: operation(['P', 'A'], { uri, principal }, true),
  DeleteACL: operation(['P', 'A'], { uri }, true),
  ListExperienceTrajectories: operation(['P'], { ...experience, limit: count.optional(), offset: count.optional() }),
  GetExperienceOutcomes: operation(['P'], experience),
  AdminCreateAccount: operation(['S'], { accountId: name, adminUserId: name }, true),
  AdminCreateAccountWithOptions: operation(['S'], { accountId: name, adminUserId: name, ...privateOptions }, true),
  AdminListAccounts: operation(['S'], {}),
  AdminListAccountsWithOptions: operation(['S'], pagination),
  AdminDeleteAccount: operation(['S'], { accountId: name }, true),
  AdminRegisterUser: operation(['A', 'S'], { ...user, role: optionalRole }, true),
  AdminRegisterUserWithOptions: operation(['A', 'S'], { ...user, role: optionalRole, ...privateOptions }, true),
  AdminListUsers: operation(['A', 'S'], account),
  AdminListUsersWithOptions: operation(['A', 'S'], { ...account, ...pagination, role: optionalRole }),
  AdminRemoveUser: operation(['A', 'S'], user, true),
  AdminSetRole: operation(['A', 'S'], { ...user, role }, true),
  AdminRegenerateKey: operation(['A', 'S'], user, true),
  AdminRegenerateKeyWithOptions: operation(['A', 'S'], { ...user, ...privateOptions }, true),
  AdminMigrate: operation(['S'], { cleanup: z.boolean().optional() }, true),
  AdminCreateGroup: operation(['A'], group, true),
  AdminListGroups: operation(['A'], {}),
  AdminDeleteGroup: operation(['A'], group, true),
  AdminListGroupMembers: operation(['A'], group),
  AdminAddGroupMember: operation(['A'], { ...group, userId: name }, true),
  AdminRemoveGroupMember: operation(['A'], { ...group, userId: name }, true),
  AdminGetAgentEvolution: operation(['A', 'S'], {}),
  AdminSetAgentEvolution: operation(['A', 'S'], { enabled: z.boolean() }, true),
  AdminGetAccountSettings: operation(['A', 'S'], account),
  AdminSetAccountAgentEvolution: operation(['A', 'S'], { ...account, enabled: z.boolean() }, true),
  WaitProcessed: operation(['S'], { timeout: z.number().finite().min(0).max(300).optional() }),
  CheckConsistency: operation(['S'], { uri }),
  Health: operation(['A', 'S'], {}),
  QueueStatus: operation(['S'], display),
  VikingDBStatus: operation(['S'], display),
  ModelsStatus: operation(['S'], display),
  GetStatus: operation(['S'], display),
  IsHealthy: operation(['S'], {}),
} as const;

export type OpenVikingManagementMethod = keyof typeof openVikingManagement;
export function isOpenVikingManagementWrite(method: OpenVikingManagementMethod, input: Record<string, unknown> = {}) {
  return openVikingManagement[method].mutates || method === 'GetSession' && input.auto_create === true;
}
export const OpenVikingManagementRequestSchema = z.object({
  connectionId: z.string().uuid(),
  method: z.custom<OpenVikingManagementMethod>(value => typeof value === 'string' && Object.hasOwn(openVikingManagement, value)),
  input: z.record(z.unknown()),
}).strict().refine(value => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 262144; }
  catch { return false; }
});
const connectionFields = { endpoint: MemoryEndpointSchema, apiKey: z.string().regex(/^[\x21-\x7e]{1,4096}$/) };
export const OpenVikingManagementConnectionSchema = z.discriminatedUnion('role', [
  z.object({ ...connectionFields, role: z.literal('P'), accountId: name, userId: name, peerId: name }).strict(),
  z.object({ ...connectionFields, role: z.literal('A'), accountId: name, userId: name }).strict(),
  z.object({ ...connectionFields, role: z.literal('S') }).strict(),
]);
export type OpenVikingManagementConnection = z.infer<typeof OpenVikingManagementConnectionSchema>;
export type OpenVikingManagementView = { connectionId: string; role: OpenVikingManagementRole; endpoint: string; accountId: string | null };
export const OpenVikingManagementTaskIdSchema = name;
export const OpenVikingManagementReceiptSchema = z.object({
  operationId: z.string().uuid(),
  state: z.enum(['unknown', 'accepted', 'running', 'confirmed', 'verified', 'completed', 'failed', 'cancelled', 'abandoned']),
  taskId: OpenVikingManagementTaskIdSchema.optional(),
  request: OpenVikingManagementRequestSchema,
}).strict();
export const OpenVikingManagementReceiptActionSchema = z.object({
  connectionId: z.string().uuid(), operationId: z.string().uuid(), action: z.enum(['check', 'abandon']),
}).strict();
export type OpenVikingManagementReceipt = Pick<z.infer<typeof OpenVikingManagementReceiptSchema>, 'operationId' | 'state' | 'taskId'>
  & { method: OpenVikingManagementMethod };
export type OpenVikingManagementApi = {
  connect(): Promise<Result<OpenVikingManagementView | null>>;
  disconnect(connectionId: string): Promise<Result<void>>;
  execute(input: z.infer<typeof OpenVikingManagementRequestSchema>): Promise<Result<unknown>>;
  receipt(connectionId: string): Promise<Result<OpenVikingManagementReceipt | null>>;
  resolveReceipt(input: z.infer<typeof OpenVikingManagementReceiptActionSchema>): Promise<Result<OpenVikingManagementReceipt>>;
};
