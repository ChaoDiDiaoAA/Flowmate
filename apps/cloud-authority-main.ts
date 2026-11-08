import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { appError, CloudWorkspaceIdSchema, fail, INVOICE_REVIEW_TOOL_NAMES, MemoryCaptureModeSchema, MemoryEndpointSchema, ok, PersonalAgentConfigurationSchema,
  RUNTIME_CONFIG, SKILL_RESOURCE_TOOL_NAMES, type ProviderConfig } from '@flowmate/contracts';
import { resolveProductPaths } from '@flowmate/shared';
import { createApplication } from './composition.ts';
import { safeCloudAncestors } from './cloud-paths.ts';
import { cloudOpenVikingSockets } from './cloud-openviking-sockets.ts';
import type { CloudOpenVikingManagementRoleBinding } from './cloud-openviking-authority.ts';
import { OpenVikingManagementConnectionSchema } from '../packages/contracts/src/openviking-management.ts';

const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !value.includes('\0'));
const memoryIdentity = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
const configuration = z.object({ version: z.literal(1), productRoot: absolutePath, resourceRoot: absolutePath,
  workspaceId: CloudWorkspaceIdSchema, desktopSocket: absolutePath, authoritySocket: absolutePath, modelSocket: absolutePath, runtimeSocket: absolutePath,
  model: z.object({ id: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/), name: z.string().trim().min(1).max(128),
    contextWindow: z.number().int().positive().max(2_000_000), maxTokens: z.number().int().positive().max(2_000_000), reasoning: z.boolean() }).strict(),
  memory: z.object({ endpoint: MemoryEndpointSchema, accountId: memoryIdentity, userId: memoryIdentity, peerId: memoryIdentity,
    recallEnabled: z.boolean(), captureMode: MemoryCaptureModeSchema }).strict().optional(),
  openVikingManagement: z.object({ endpoint: MemoryEndpointSchema,
    P: z.object({ accountId: memoryIdentity, userId: memoryIdentity, peerId: memoryIdentity }).strict().optional(),
    A: z.object({ accountId: memoryIdentity, userId: memoryIdentity }).strict().optional(), S: z.literal(true).optional(),
  }).strict().refine(value => !!(value.P || value.A || value.S)).optional(),
}).strict().refine(value => {
  const sockets = [value.desktopSocket, value.authoritySocket, value.modelSocket, value.runtimeSocket];
  if (value.openVikingManagement) for (const role of ['P', 'A', 'S'] as const) {
    if (value.openVikingManagement[role]) sockets.push(cloudOpenVikingSockets[role]);
  }
  return value.model.maxTokens <= value.model.contextWindow && new Set(sockets).size === sockets.length;
});

type CredentialName = 'deepseek-api-key' | 'openviking-user-key' | `openviking-management-${'p' | 'a' | 's'}-key`;
const managementKeys = { P: 'openviking-management-p-key', A: 'openviking-management-a-key', S: 'openviking-management-s-key' } as const;
function credentialFile(name: CredentialName): string | undefined {
  const directory = process.env.CREDENTIALS_DIRECTORY;
  if (!directory || !absolutePath.safeParse(directory).success || typeof process.getuid !== 'function') return undefined;
  try {
    const file = join(directory, name), info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size < 1 || info.size > 8192
      || info.uid !== 0 && info.uid !== process.getuid() || realpathSync(file) !== file || !safeCloudAncestors(file, process.getuid())) return undefined;
    const value = readFileSync(file, 'utf8').trim();
    return /^[\x21-\x7e]{1,4096}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}
function credential(): string | undefined { return credentialFile('deepseek-api-key'); }

/** Only Authority reads the systemd credential; configuration contains no model secret. */
export async function runCloudAuthorityMain(configPath: string): Promise<boolean> {
  if (process.platform !== 'linux' || !absolutePath.safeParse(configPath).success || typeof process.getuid !== 'function') return false;
  let raw: unknown;
  try {
    const info = lstatSync(configPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384 || (info.mode & 0o022) !== 0
      || info.uid !== 0 && info.uid !== process.getuid() || realpathSync(configPath) !== configPath || !safeCloudAncestors(configPath, process.getuid())) return false;
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch { return false; }
  const parsed = configuration.safeParse(raw); if (!parsed.success || !credential()) return false;
  const config = parsed.data;
  try {
    const root = lstatSync(config.productRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(config.productRoot) !== config.productRoot
      || typeof process.getuid !== 'function' || root.uid !== process.getuid() || (root.mode & 0o077) !== 0
      || !safeCloudAncestors(config.productRoot, root.uid)) return false;
  } catch { return false; }
  const paths = resolveProductPaths(config.productRoot); if (!paths.ok) return false;
  const management = config.openVikingManagement;
  const managementRoles: CloudOpenVikingManagementRoleBinding[] = [];
  if (management) for (const role of ['P', 'A', 'S'] as const) {
    const identity = management[role];
    if (!identity) continue;
    const parsedRole = OpenVikingManagementConnectionSchema.safeParse({ endpoint: management.endpoint, role,
      apiKey: credentialFile(managementKeys[role]), ...(identity === true ? {} : identity) });
    if (!parsedRole.success) return false;
    managementRoles.push({ socketPath: cloudOpenVikingSockets[role], connection: parsedRole.data });
  }
  const provider: ProviderConfig = { version: 1, name: 'deepseek-official', revision: 1,
    modelRef: { provider: 'flowmate-deepseek', model: config.model.name },
    native: { authPath: join(paths.data.runtimeDir, 'cloud-model-auth.json'), modelsPath: null },
    connection: { baseUrl: 'https://api.deepseek.com', api: 'openai-completions', contextWindow: config.model.contextWindow,
      maxTokens: config.model.maxTokens, reasoning: config.model.reasoning }, parameters: { ...RUNTIME_CONFIG.provider } };
  const selected = PersonalAgentConfigurationSchema.parse({ modelId: config.model.id, thinkingLevel: 'off',
    tools: [...INVOICE_REVIEW_TOOL_NAMES, ...SKILL_RESOURCE_TOOL_NAMES, 'Agent'], resources: { prompt: null, enabledSkills: [] },
    extensions: { enabledExtensions: [] }, workingDirectory: null, preferences: '' });
  const app = await createApplication({ paths: paths.data, resourceRoot: config.resourceRoot,
    ...(config.memory ? { memory: { owner: { environment: 'cloud' as const, ownerId: config.workspaceId },
      readCredential: async (reference: string) => reference === 'openviking-user-key' ? credentialFile('openviking-user-key') : undefined,
      initialConnection: { ...config.memory, credentialRef: 'openviking-user-key' } } } : {}),
    personalAgent: { defaultConfiguration: selected,
      resolveConfiguration: modelId => modelId === config.model.id ? ok(provider)
        : fail(appError('model_not_configured', 'input', 'The selected cloud model is unavailable.')),
      readApiKey: credential },
    cloudAuthority: { workspaceId: config.workspaceId, runtimeSocket: config.runtimeSocket, desktopSocket: config.desktopSocket,
      authoritySocket: config.authoritySocket, modelSocket: config.modelSocket, readApiKey: credential,
      ...(management ? { openVikingManagement: managementRoles } : {}) } });
  if (!app.ok) return false;
  let signal!: () => void;
  const requested = new Promise<void>(resolveStop => { signal = resolveStop; });
  process.once('SIGTERM', signal); process.once('SIGINT', signal);
  process.stdout.write('[Flowmate] cloud_authority_ready\n');
  await requested;
  process.off('SIGTERM', signal); process.off('SIGINT', signal);
  const stopped = await app.data.close();
  return stopped.ok && stopped.data.stopped && stopped.data.closed;
}

if (import.meta.main) {
  const result = process.argv.length === 3 && await runCloudAuthorityMain(process.argv[2]!).catch(() => false);
  if (!result) { process.stderr.write('[Flowmate] cloud_authority_failed\n'); process.exitCode = 1; }
}
