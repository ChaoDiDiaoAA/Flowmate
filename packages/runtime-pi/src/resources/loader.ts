import { loadSkillsFromDir, formatSkillsForPrompt, createExtensionRuntime, parseSkillBlock, stripFrontmatter,
  truncateHead, DEFAULT_MAX_BYTES, formatSize, type ResourceLoader, type Skill, type LoadExtensionsResult } from '@earendil-works/pi-coding-agent';
import { appError, fail, ok, ResourceNativeMetadataSchema, FrozenResourcesSchema, ResourceBundleManifestSchema, ResourceManifestSchema,
  RESOURCE_LIMITS, canonicalResourceManifest, resourceRefKey } from '@flowmate/contracts';
import type { InspectNativeResources, FrozenResources, ResourceRef, Result } from '@flowmate/contracts';
import { resolve, join, relative, isAbsolute, sep } from 'node:path';
import { lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveNativeFilePath } from '@flowmate/shared';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const resourcePath = (ref: ResourceRef) => `${ref.kind === 'prompt' ? 'prompts' : 'skills'}/${ref.id}/${ref.version}`;
export type ManagedReadFile = { ref: ResourceRef; path: string; fileHash: string; text: string | null; relativePath: string };
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
  bundleDirectory: string; extensionResult?: LoadExtensionsResult }): Result<ResourceLoader & { bodyFor(ref: ResourceRef): string | null;
    filesForOperation(path: string, cwd: string, operation: string): ManagedReadFile[] }> {
  try {
    const skills: Skill[] = [], appended: string[] = [], sources: Array<{ path: string }> = [];
    const bodies = new Map<string, string>();
    const files: Array<{ ref: ResourceRef; path: string; bytes: number; sha256: string }> = [];
    if (input.frozen !== null) {
      const frozen = FrozenResourcesSchema.parse(input.frozen), root = resolve(input.bundleDirectory);
      if (!samePath(root, resolve(frozen.bundleDirectory))) throw new Error('Frozen content location differs from the controlled Loader root.');
      const manifest = ResourceBundleManifestSchema.parse(JSON.parse(decoder.decode(readFixed(root, 'bundle.json', RESOURCE_LIMITS.manifestBytes * RESOURCE_LIMITS.packages * 2 + 65536))));
      const refs = [...(frozen.prompt ? [frozen.prompt] : []), ...frozen.discoveredSkills];
      const ordered = manifest.resources.map(item => item.ref).sort((a, b) => {
        const left = JSON.stringify([a.kind, a.id, a.version, a.contentHash]), right = JSON.stringify([b.kind, b.id, b.version, b.contentHash]);
        return left < right ? -1 : left > right ? 1 : 0;
      });
      if (manifest.bundleHash !== frozen.bundleHash || hash(JSON.stringify(ordered)) !== frozen.bundleHash
        || frozen.manifests.some(item => hash(canonicalResourceManifest(item.manifest)) !== item.ref.contentHash)
        || refs.length !== manifest.resources.length || refs.some(ref => !manifest.resources.some(item => resourceRefKey(item.ref) === resourceRefKey(ref))))
        throw new Error('Fixed bundle membership changed.');
      for (const item of manifest.resources) {
        if (hash(canonicalResourceManifest(item.manifest)) !== item.ref.contentHash) throw new Error('Fixed manifest changed.');
        const copied = ResourceManifestSchema.parse(JSON.parse(decoder.decode(readFixed(root, `${resourcePath(item.ref)}/resource.json`, RESOURCE_LIMITS.manifestBytes))));
        if (hash(canonicalResourceManifest(copied)) !== item.ref.contentHash) throw new Error('Fixed copied manifest changed.');
        const bodyPath = `${resourcePath(item.ref)}/${item.manifest.bodyFile}`;
        let body: Buffer | undefined;
        for (const file of item.manifest.files) {
          const content = readFixed(root, `${resourcePath(item.ref)}/${file.path}`, RESOURCE_LIMITS.fileBytes);
          if (content.length !== file.bytes || hash(content) !== file.sha256) throw new Error('Fixed file identity changed.');
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
            || hash(readFixed(root, bodyPath, RESOURCE_LIMITS.bodyBytes)) !== hash(body)) throw new Error('Fixed native Skill could not be verified.');
          skills.push(skill);
        }
      }
      if (Buffer.byteLength(formatSkillsForPrompt(skills, 'read')) > RESOURCE_LIMITS.indexBytes) throw new Error('Native Skill index exceeds its limit.');
    }
    return ok({
      bodyFor: ref => bodies.get(resourceRefKey(ref)) ?? null,
      filesForOperation: (path, cwd, operation) => {
        const target = resolveNativeFilePath(path, cwd), root = resolve(input.bundleDirectory);
        return files.flatMap(file => {
          const filePath = `${resourcePath(file.ref)}/${file.path}`, absolute = resolve(root, filePath), rel = relative(target, absolute);
          if (!samePath(target, absolute) && (operation === 'read' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) return [];
          const content = readFixed(root, filePath, RESOURCE_LIMITS.fileBytes);
          if (content.length !== file.bytes || hash(content) !== file.sha256) throw new Error('Managed file changed during native read.');
          let text: string | null = null; try { text = decoder.decode(content); } catch { /* Binary output is not full text evidence. */ }
          return [{ ref: file.ref, path: file.path, fileHash: file.sha256, text, relativePath: rel }];
        });
      },
      getExtensions: () => input.extensionResult ?? ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [...skills], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => input.fixedSystemPrompt,
      getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [...appended],
      getAppendSystemPromptSources: () => [...sources],
      extendResources: () => { throw new Error('agent_resources_disabled'); }, reload: async () => {},
    });
  } catch { return fail(appError('resource_bundle_unavailable', 'storage', 'Fixed Pi resources could not be assembled.', true)); }
}

/** Verify the result created by Pi; never construct or execute a Skill message here. */
export function verifySkillExpansion(input: { text: string; skill: Skill; expectedBody: string;
  expectedUserMessage: string }): Result<{ expandedTextHash: string }> {
  const block = parseSkillBlock(input.text);
  if (!block || block.name !== input.skill.name || block.location !== input.skill.filePath
    || block.content !== `References are relative to ${input.skill.baseDir}.\n\n${stripFrontmatter(input.expectedBody).trim()}`
    || block.userMessage !== input.expectedUserMessage.trim())
    return fail(appError('resource_expansion_mismatch', 'runtime', 'Pi did not expand the required Skill at its fixed version.'));
  return ok({ expandedTextHash: hash(input.text) });
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
