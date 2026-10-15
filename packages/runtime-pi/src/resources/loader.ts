import { loadSkillsFromDir, formatSkillsForPrompt, createExtensionRuntime, parseSkillBlock, stripFrontmatter,
  truncateHead, DEFAULT_MAX_BYTES, formatSize, type ResourceLoader, type Skill, type LoadExtensionsResult } from '@earendil-works/pi-coding-agent';
import { appError, fail, ok, ResourceNativeMetadataSchema, FrozenResourcesSchema, ResourceBundleManifestSchema, ResourceManifestSchema,
  RESOURCE_LIMITS, canonicalResourceManifest, resourceRefKey, formatSkillReadinessSection } from '@flowmate/contracts';
import { ListSkillResourcesInputSchema, ListSkillResourcesOutputSchema, ReadSkillResourceInputSchema, ReadSkillResourceOutputSchema } from '@flowmate/contracts';
import type { InspectNativeResources, FrozenResources, ResourceRef, Result, SkillIndexEntry, FrozenInputDefinitions, ManagedFileContents } from '@flowmate/contracts';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolveNativeFilePath } from '@flowmate/shared';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const resourcePath = (ref: ResourceRef) => `${ref.kind === 'prompt' ? 'prompts' : 'skills'}/${ref.id}/${ref.version}`;
export type ManagedReadFile = { ref: ResourceRef; path: string; text: string | null; relativePath: string };
export { formatSkillReadinessSection } from '@flowmate/contracts';
/** Match this installed SDK's observable text projection, using its public truncation helper. */
export function verifyManagedReadOutput(file: ManagedReadFile, args: Record<string, unknown>, text: string): Result<void> {
  if (file.text === null) return ok(undefined);
  const lines = file.text.split('\n'), start = typeof args.offset === 'number' && args.offset ? Math.max(0, args.offset - 1) : 0;
  const end = typeof args.limit === 'number' ? Math.min(start + args.limit, lines.length) : lines.length;
  const selected = lines.slice(start, end).join('\n'), truncated = truncateHead(selected);
  let expected = truncated.content;
  if (truncated.firstLineExceedsLimit) expected = `[Line ${start + 1} is ${formatSize(Buffer.byteLength(lines[start] ?? '', 'utf8'))}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${start + 1}p' ${args.path} | head -c ${DEFAULT_MAX_BYTES}]`;
  else if (truncated.truncated) {
    const last = start + truncated.outputLines;
    expected += `\n\n[Showing lines ${start + 1}-${last} of ${lines.length}${truncated.truncatedBy === 'bytes' ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : ''}. Use offset=${last + 1} to continue.]`;
  } else if (typeof args.limit === 'number' && end < lines.length)
    expected += `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
  return text === expected ? ok(undefined) : fail(appError('resource_version_changed', 'input', 'The actual managed read output differs from its fixed content.'));
}
function readFixed(root: string, path: string, limit: number): Buffer {
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Fixed file escaped its bundle.');
  let parent = root;
  for (const part of ['', ...rel.split(sep).slice(0, -1)]) {
    if (part) parent = join(parent, part);
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(resolve(parent), realpathSync(parent))) throw new Error('Fixed directory is an alias.');
  }
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(target, realpathSync(target)) || info.size > limit) throw new Error('Fixed content is unavailable.');
  const fd = openSync(target, 'r');
  try {
    const before = fstatSync(fd), content = Buffer.alloc(Math.min(limit, before.size) + 1);
    let length = 0, count: number;
    while (length < content.length && (count = readSync(fd, content, length, content.length - length, null)) > 0) length += count;
    const after = fstatSync(fd);
    if (length !== before.size || before.size > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ino !== info.ino || before.dev !== info.dev) throw new Error('Fixed content changed while being read.');
    return content.subarray(0, length);
  } finally { closeSync(fd); }
}

/** No default discovery, configuration reload, extension loading, or PromptTemplate expansion. */
export function createRunResourceLoader(input: { fixedSystemPrompt: string; frozen: FrozenResources | null;
  bundleDirectory: string; contents?: Pick<ManagedFileContents, 'read'>; activeToolNames?: readonly string[]; visibleSkillRefs?: readonly ResourceRef[]; roleIndex?: string;
  templates?: FrozenInputDefinitions['templates']; child?: boolean; extensionResult?: LoadExtensionsResult }): Result<ResourceLoader & { bodyFor(ref: ResourceRef): string | null;
    readinessFor(ref: ResourceRef): string | null;
    filesForOperation(path: string, cwd: string, operation: string): ManagedReadFile[] }> {
  try {
    const skills: Skill[] = [], appended: string[] = [], sources: Array<{ path: string }> = [];
    const bodies = new Map<string, string>();
    const files: Array<{ ref: ResourceRef; path: string; bytes: number }> = [];
    const readiness = new Map<string, string>();
    const readOriginal = (path: string, limit: number) => {
      const content = readFixed(resolve(input.bundleDirectory), path, limit);
      const saved = input.frozen && input.contents?.read({ ownerKind: 'resource-bundle', ownerId: input.frozen.bundleId, relativePath: path });
      if (!saved || !content.equals(Buffer.from(saved))) throw new Error('Original bundle content is missing or changed.');
      return content;
    };
    if (input.roleIndex) {
      if (Buffer.byteLength(input.roleIndex) > 16384) throw new Error('Role index exceeds 16 KiB.');
      appended.push('Registered subagent roles (use Agent with subagent_type; independent calls can run concurrently, maximum four):\n'+input.roleIndex);
    }
    if (input.frozen !== null) {
      const frozen = FrozenResourcesSchema.parse(input.frozen), root = resolve(input.bundleDirectory);
      const visible = new Set((input.visibleSkillRefs ?? frozen.discoveredSkills).map(resourceRefKey));
      if (input.visibleSkillRefs?.some(ref => !frozen.discoveredSkills.some(item => resourceRefKey(item) === resourceRefKey(ref)))
        || input.visibleSkillRefs && visible.size !== input.visibleSkillRefs.length) throw new Error('Visible Skills exceed the fixed bundle.');
      if (!samePath(root, resolve(frozen.bundleDirectory))) throw new Error('Frozen content location differs from the controlled Loader root.');
      const manifest = ResourceBundleManifestSchema.parse(JSON.parse(decoder.decode(readOriginal('bundle.json', RESOURCE_LIMITS.manifestBytes * RESOURCE_LIMITS.packages * 2 + 65536))));
      const refs = [...(frozen.prompt ? [frozen.prompt] : []), ...frozen.discoveredSkills];
      if (manifest.bundleId !== frozen.bundleId || JSON.stringify(manifest.resources) !== JSON.stringify(frozen.manifests)
        || JSON.stringify(manifest.skillIndex) !== JSON.stringify(frozen.skillIndex)
        || refs.length !== manifest.resources.length || refs.some(ref => !manifest.resources.some(item => resourceRefKey(item.ref) === resourceRefKey(ref))))
        throw new Error('Fixed bundle membership changed.');
      for (const item of manifest.resources) {
        const copied = ResourceManifestSchema.parse(JSON.parse(decoder.decode(readOriginal(`${resourcePath(item.ref)}/resource.json`, RESOURCE_LIMITS.manifestBytes))));
        if (canonicalResourceManifest(copied) !== canonicalResourceManifest(item.manifest)) throw new Error('Fixed copied manifest changed.');
        const bodyPath = `${resourcePath(item.ref)}/${item.manifest.bodyFile}`;
        let body: Buffer | undefined;
        for (const file of item.manifest.files) {
          const content = readOriginal(`${resourcePath(item.ref)}/${file.path}`, RESOURCE_LIMITS.fileBytes);
          if (content.length !== file.bytes) throw new Error('Fixed file identity changed.');
          if (file.path === item.manifest.bodyFile) body = content;
          files.push({ ref: item.ref, ...file });
        }
        if (!body) throw new Error('Fixed body missing.');
        bodies.set(resourceRefKey(item.ref), decoder.decode(body));
        if (item.ref.kind === 'prompt') { appended.push(decoder.decode(body)); sources.push({ path: join(root, bodyPath) }); }
        else {
          const directory = join(root, resourcePath(item.ref)), loaded = loadSkillsFromDir({ dir: directory, source: 'path' }), skill = loaded.skills[0];
          if (loaded.skills.length !== 1 || loaded.diagnostics.length || !skill || skill.name !== item.ref.id
            || !samePath(resolve(skill.baseDir), resolve(directory))
            || !ResourceNativeMetadataSchema.safeParse({ name: skill.name, description: skill.description,
              disableModelInvocation: skill.disableModelInvocation, diagnostics: [] }).success
            || !readOriginal(bodyPath, RESOURCE_LIMITS.bodyBytes).equals(body)) throw new Error('Fixed native Skill could not be verified.');
          if (visible.has(resourceRefKey(item.ref))) skills.push(skill);
        }
      }
      for (let i = files.length - 1; i >= 0; i--) if (files[i]!.ref.kind === 'skill' && !visible.has(resourceRefKey(files[i]!.ref))) files.splice(i, 1);
      for (const ref of frozen.discoveredSkills) if (!visible.has(resourceRefKey(ref))) bodies.delete(resourceRefKey(ref));
      const toolNames = input.activeToolNames ?? ['read'];
      for (const entry of frozen.skillIndex?.entries ?? []) readiness.set(resourceRefKey(entry.ref),
        formatSkillReadinessSection(entry, toolNames, input.visibleSkillRefs ?? frozen.discoveredSkills, input.child === true));
      const readinessSection = readiness.size ? 'Skill readiness for this Run (diagnostics do not grant execution permission):\n'+[...readiness.values()].join('\n') : '';
      const index = formatSkillsForPrompt(skills, 'read');
      const guidance = toolNames.includes('read_skill_resource') && skills.length
        ? 'For registered Skills, use list_skill_resources({skill}) to list files and read_skill_resource({skill, path, offset?, limit?}) to read UTF-8 pages from this Run’s fixed bundle. Use the listed Skill name, SKILL.md for its body, and a listed relative path for references. Listing does not read bodies; reading scripts does not execute them.' : '';
      const nativeIndex = toolNames.includes('read') || toolNames.includes('bash');
      const fallback = !nativeIndex && guidance ? (index.match(/  <skill>[\s\S]*?  <\/skill>/g) ?? []).join('\n') : '';
      if (Buffer.byteLength(index) + Buffer.byteLength(guidance) + Buffer.byteLength(readinessSection) > RESOURCE_LIMITS.indexBytes) throw new Error('Native Skill index and reading guidance exceed their limit.');
      if (readinessSection) appended.push(readinessSection);
      if (guidance) appended.push([guidance, fallback && `<available_skills>\n${fallback}\n</available_skills>`].filter(Boolean).join('\n\n'));
    }
    return ok({
      bodyFor: ref => bodies.get(resourceRefKey(ref)) ?? null,
      readinessFor: ref => readiness.get(resourceRefKey(ref)) ?? null,
      filesForOperation: (path, cwd, operation) => {
        const target = resolveNativeFilePath(path, cwd), root = resolve(input.bundleDirectory);
        return files.flatMap(file => {
          const filePath = `${resourcePath(file.ref)}/${file.path}`, absolute = resolve(root, filePath), rel = relative(target, absolute);
          if (!samePath(target, absolute) && (operation === 'read' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) return [];
          const content = readOriginal(filePath, RESOURCE_LIMITS.fileBytes);
          if (content.length !== file.bytes) throw new Error('Managed file changed during native read.');
          let text: string | null = null; try { text = decoder.decode(content); } catch { /* Binary output is not full text evidence. */ }
          if (text !== null && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) text = null;
          return [{ ref: file.ref, path: file.path, text, relativePath: rel }];
        });
      },
      getExtensions: () => input.extensionResult ?? ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [...skills], diagnostics: [] }),
      getPrompts: () => ({ prompts: (input.templates ?? []).map(template => ({ name: template.name,
        description: template.description, content: template.content, filePath: template.filePath,
        sourceInfo: { path: template.filePath, source: 'Flowmate fixed input', scope: 'temporary' as const, origin: 'top-level' as const } })), diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => input.fixedSystemPrompt,
      getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [...appended],
      getAppendSystemPromptSources: () => [...sources],
      extendResources: () => { throw new Error('agent_resources_disabled'); }, reload: async () => {},
    });
  } catch { return fail(appError('resource_bundle_unavailable', 'storage', 'Fixed Pi resources could not be assembled.', true)); }
}

/** Recheck structured feedback against fixed files before recording SDK delivery evidence. */
export function verifySkillToolOutput(frozen: FrozenResources, loader: Extract<ReturnType<typeof createRunResourceLoader>, { ok: true }>['data'],
  contents: Pick<ManagedFileContents, 'read'>, operation: 'list_skill_resources' | 'read_skill_resource', raw: unknown, output: unknown): Result<Array<ManagedReadFile & { fullBody: boolean }>> {
  try {
    const args = operation === 'list_skill_resources' ? ListSkillResourcesInputSchema.parse(raw) : ReadSkillResourceInputSchema.parse(raw);
    const data = operation === 'list_skill_resources' ? ListSkillResourcesOutputSchema.parse(output) : ReadSkillResourceOutputSchema.parse(output);
    const item = frozen.manifests.find(item => resourceRefKey(item.ref) === resourceRefKey(data.ref));
    if (!item || data.bundleId !== frozen.bundleId || data.ref.id !== args.skill || loader.bodyFor(data.ref) === null) throw new Error('Hidden or foreign Skill.');
    if ('files' in data) {
      const ordered = [...item.manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      if (JSON.stringify(data.files) !== JSON.stringify(ordered)) throw new Error('Listed metadata changed.');
      return ok(ordered.map(file => ({ ref: data.ref, path: file.path, text: null, relativePath: file.path, fullBody: false })));
    }
    const readArgs = ReadSkillResourceInputSchema.parse(raw);
    const member = item.manifest.files.find(file => file.path === readArgs.path);
    const original = member && contents.read({ ownerKind: 'resource-bundle', ownerId: frozen.bundleId,
      relativePath: `${resourcePath(data.ref)}/${member.path}` });
    if (!member || !original || original.byteLength !== member.bytes || data.path !== readArgs.path
      || data.offset !== (readArgs.offset ?? 0)) throw new Error('Read identity changed.');
    const content = Buffer.from(original), text = decoder.decode(content), start = data.offset;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('Read content is binary.');
    if (start > content.length || start < content.length && (content[start]! & 0xc0) === 0x80) throw new Error('Invalid UTF-8 offset.');
    let end = Math.min(start + (readArgs.limit ?? RESOURCE_LIMITS.pageBytes), content.length);
    while (end < content.length && end > start && (content[end]! & 0xc0) === 0x80) end--;
    if (data.totalBytes !== content.length || data.text !== decoder.decode(content.subarray(start, end))
      || data.nextOffset !== (end < content.length ? end : null)) throw new Error('Read projection changed.');
    return ok([{ ref: data.ref, path: member.path, text, relativePath: '', fullBody: start === 0 && end === content.length }]);
  } catch { return fail(appError('resource_evidence_conflict', 'runtime', 'Structured Skill feedback differs from its fixed file.')); }
}

/** Verify the result created by Pi; never construct or execute a Skill message here. */
export function verifySkillExpansion(input: { text: string; skill: Skill; expectedBody: string;
  expectedUserMessage: string }): Result<{ expandedText: string }> {
  const block = parseSkillBlock(input.text);
  if (!block || block.name !== input.skill.name || block.location !== input.skill.filePath
    || block.content !== `References are relative to ${input.skill.baseDir}.\n\n${stripFrontmatter(input.expectedBody).trim()}`
    || block.userMessage !== input.expectedUserMessage.trim())
    return fail(appError('resource_expansion_mismatch', 'runtime', 'Pi did not expand the required Skill at its fixed version.'));
  return ok({ expandedText: input.text });
}

/** Only the explicitly verified version root is passed to Pi; no default discovery. */
export const inspectNativeResources: InspectNativeResources = ({ versionDirectory, manifest }) => {
  if (manifest.kind !== 'skill') return fail(appError('resource_manifest_invalid', 'input', 'Native Skill inspection requires a Skill manifest.'));
  try {
    const loaded = loadSkillsFromDir({ dir: versionDirectory, source: 'path' });
    const skill = loaded.skills[0];
    if (loaded.skills.length !== 1 || !skill || resolve(skill.baseDir) !== resolve(versionDirectory))
      return fail(appError('resource_manifest_invalid', 'input', 'Pi did not discover exactly one Skill at the registered version root.'));
    const metadata = ResourceNativeMetadataSchema.safeParse({ name: skill.name, description: skill.description,
      disableModelInvocation: skill.disableModelInvocation, diagnostics: loaded.diagnostics.map(item => ({
        code: 'resource_manifest_invalid', message: item.message.slice(0, 2048) || 'Pi reported a resource diagnostic.',
      })) });
    return metadata.success ? ok(metadata.data)
      : fail(appError('resource_manifest_invalid', 'input', 'Native Skill metadata exceeds the managed resource contract.'));
  } catch {
    return fail(appError('resource_manifest_invalid', 'input', 'Pi could not inspect the registered Skill.'));
  }
};
