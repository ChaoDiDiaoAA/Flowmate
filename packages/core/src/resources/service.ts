import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppErrorSchema, appError, fail, ok, CONTEXT_ERROR_FACTS, RESOURCE_LIMITS,
  canonicalResourceManifest, FrozenResourcesSchema, ResourceBundleManifestSchema, ResourceCatalogSchema,
  ResourceFileRequestSchema, ResourceIdSchema, ResourceManifestSchema, ResourceRefSchema,
  ResourceSelectionSchema, resourceRefKey } from '@flowmate/contracts';
import type { FrozenResources, InspectNativeResources, ResourceBundleManifest, ResourceCatalog, ResourceDependency,
  ResourceErrorCode, ResourceFilePage, ResourceFileRequest, ResourceManifest, ResourceRef, ResourceSelection, Result } from '@flowmate/contracts';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const refOrder = (ref: ResourceRef) => JSON.stringify([ref.kind, ref.id, ref.version, ref.contentHash]);
const bundleHash = (refs: readonly ResourceRef[]) => sha256(JSON.stringify([...refs].sort((a, b) => compare(refOrder(a), refOrder(b)))));
const versionPath = (ref: Pick<ResourceRef, 'kind' | 'id' | 'version'>) => `${ref.kind === 'prompt' ? 'prompts' : 'skills'}/${ref.id}/${ref.version}`;
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Durable Run metadata proves file membership even when the preserved content directory is missing. */
export function verifyFrozenResourceMetadata(value: FrozenResources): Result<void> {
  return checked(() => {
    const frozen = FrozenResourcesSchema.parse(value);
    if (bundleHash(frozen.manifests.map(item => item.ref)) !== frozen.bundleHash
      || frozen.manifests.some(item => sha256(canonicalResourceManifest(item.manifest)) !== item.ref.contentHash))
      reject('resource_evidence_conflict', 'Frozen resource metadata does not match its original content identity.');
  });
}
/** Match Pi 0.85.1's literal prefix and space delimiter, without keyword routing. */
export function resolveRequiredSkill(text: string, requested: ResourceRef | undefined,
  available: readonly ResourceRef[]): Result<ResourceRef | null> {
  const space = text.indexOf(' '), name = text.startsWith('/skill:') ? text.slice(7, space < 0 ? undefined : space) : null;
  const command = name === null ? null : available.find(ref => ref.kind === 'skill' && ref.id === name);
  if (name !== null && !command || requested && (requested.kind !== 'skill'
    || !available.some(ref => resourceRefKey(ref) === resourceRefKey(requested))
    || command && resourceRefKey(command) !== resourceRefKey(requested)))
    return fail(appError('resource_required_unavailable', 'input', 'The explicitly requested Skill is not enabled at this version.'));
  return ok(requested ?? command ?? null);
}
function reject(code: ResourceErrorCode, message: string): never {
  const [category, retryable] = CONTEXT_ERROR_FACTS[code]!;
  throw appError(code, category, message, retryable);
}
function checked<T>(action: () => T, code: ResourceErrorCode = 'resource_manifest_invalid'): Result<T> {
  try { return ok(action()); } catch (error) {
    const product = AppErrorSchema.safeParse(error);
    return product.success ? fail(product.data) : fail(appError(code, ...errorFacts(code)));
  }
}
function errorFacts(code: ResourceErrorCode): [import('@flowmate/contracts').ErrorCategory, string, boolean] {
  const [category, retryable] = CONTEXT_ERROR_FACTS[code]!;
  return [category, 'Managed resource files could not be verified.', retryable];
}
function directory(path: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(resolve(path), realpathSync(path)))
    reject('resource_file_unavailable', 'Managed resource directories cannot be links or aliases.');
}
function safePath(root: string, path: string): string {
  directory(root);
  const target = resolve(root, path), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    reject('resource_file_unavailable', 'Resource file lies outside its registered root.');
  let current = root;
  for (const part of rel.split(sep).slice(0, -1)) { current = join(current, part); directory(current); }
  const info = lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || !samePath(target, realpathSync(target)))
    reject('resource_file_unavailable', 'Resource content must be an ordinary registered file.');
  return target;
}
function bytes(path: string, maximum: number): Buffer {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) reject('resource_file_unavailable', 'Resource content must be an ordinary file.');
  if (info.size > maximum) reject('resource_content_too_large', 'Resource content exceeds its byte budget.');
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd);
    if (before.ino !== info.ino || before.dev !== info.dev || before.size !== info.size)
      reject('resource_version_changed', 'Resource changed while it was being opened.');
    const data = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < data.length) {
      const count = readSync(fd, data, size, data.length - size, null);
      if (!count) break; size += count;
    }
    const after = fstatSync(fd), current = lstatSync(path);
    if (size !== info.size || after.size !== info.size || after.mtimeMs !== before.mtimeMs
      || current.ino !== info.ino || current.dev !== info.dev || current.isSymbolicLink())
      reject('resource_version_changed', 'Resource changed during its bounded read.');
    return data.subarray(0, size);
  } finally { closeSync(fd); }
}
function writeSynced(path: string, content: string | Uint8Array) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
}
type Package = { ref: ResourceRef; manifest: ResourceManifest; directory: string; contents: Map<string, Buffer>;
  item: ResourceCatalog['items'][number] };
type AvailableExtensions = readonly { id: string; version: string }[];
type CatalogInput = { revision: number; selection: ResourceSelection; availableExtensions?: AvailableExtensions };

export function createResourceService(options: { resourceRoot: string; bundleRoot: string;
  registeredToolNames: readonly string[]; inspectNativeResources: InspectNativeResources }) {
  const authorRoot = resolve(options.resourceRoot), bundleRoot = resolve(options.bundleRoot);
  const registeredTools = new Set(options.registeredToolNames);
  function load(kind: 'prompt' | 'skill', id: string, version: string): Package {
    const root = join(authorRoot, kind === 'prompt' ? 'prompts' : 'skills', id, version);
    const manifest = ResourceManifestSchema.parse(JSON.parse(decoder.decode(bytes(safePath(authorRoot,
      `${kind === 'prompt' ? 'prompts' : 'skills'}/${id}/${version}/resource.json`), RESOURCE_LIMITS.manifestBytes))));
    if (manifest.kind !== kind || manifest.id !== id || manifest.version !== version)
      reject('resource_name_conflict', 'Resource manifest and registered version directory disagree.');
    const ref = ResourceRefSchema.parse({ kind, id, version, contentHash: sha256(canonicalResourceManifest(manifest)) });
    const contents = new Map<string, Buffer>();
    let name = id, description = '', disableModelInvocation = false;
    const diagnostics: Array<{ code: string; message: string }> = [];
    const verified = checked(() => {
      for (const file of manifest.files) {
        const content = bytes(safePath(root, file.path), RESOURCE_LIMITS.fileBytes);
        if (file.bytes !== content.length || file.sha256 !== sha256(content))
          reject('resource_version_changed', 'Resource file content differs from its fixed manifest.');
        contents.set(file.path, content);
      }
      const body = decoder.decode(contents.get(manifest.bodyFile)!);
      if (kind === 'prompt') description = body.split(/\r?\n/).find(line => line.trim())?.slice(0, 128) ?? '';
      else {
        const metadata = options.inspectNativeResources({ versionDirectory: root, manifest });
        if (!metadata.ok) throw metadata.error;
        name = metadata.data.name; description = metadata.data.description; disableModelInvocation = metadata.data.disableModelInvocation;
        diagnostics.push(...metadata.data.diagnostics);
        if (name !== id) reject('resource_name_conflict', 'Pi Skill name and product resource ID disagree.');
        // Pi reads SKILL.md itself; a concurrent author edit must not change the verified metadata.
        if (sha256(bytes(safePath(root, manifest.bodyFile), RESOURCE_LIMITS.bodyBytes)) !== manifest.files.find(file => file.path === manifest.bodyFile)!.sha256)
          reject('resource_version_changed', 'Skill body changed during native discovery.');
      }
    });
    if (!verified.ok) diagnostics.push({ code: verified.error.code, message: verified.error.message });
    return { ref, manifest, directory: root, contents, item: { ref, name, description, keywords: manifest.keywords,
      enabled: false, available: diagnostics.length === 0, disableModelInvocation, bodyFile: manifest.bodyFile, files: manifest.files, dependencies: manifest.requires, diagnostics } };
  }
  function discover() {
    const packages: Package[] = [], diagnostics: ResourceCatalog['diagnostics'][number][] = [];
    if (!existsSync(authorRoot)) return { packages, diagnostics };
    directory(authorRoot);
    let count = 0;
    for (const kind of ['prompt', 'skill'] as const) {
      const group = join(authorRoot, kind === 'prompt' ? 'prompts' : 'skills');
      if (!existsSync(group)) continue;
      const entries = checked(() => { directory(group); return readdirSync(group).sort(compare); });
      if (!entries.ok) { diagnostics.push({ resourceId: null, version: null, code: entries.error.code, message: `${kind}: ${entries.error.message}` }); continue; }
      for (const id of entries.data) {
        if (!ResourceIdSchema.safeParse(id).success) { diagnostics.push({ resourceId: null, version: null,
          code: 'resource_manifest_invalid', message: 'Invalid resource directory ID.' }); continue; }
        const versions = checked(() => { directory(join(group, id)); return readdirSync(join(group, id)).sort(compare); });
        if (!versions.ok) { diagnostics.push({ resourceId: id, version: null, code: versions.error.code, message: versions.error.message }); continue; }
        for (const version of versions.data) {
          if (++count > RESOURCE_LIMITS.packages) reject('resource_content_too_large', 'Resource discovery exceeds 64 registered version packages.');
          if (!ResourceIdSchema.safeParse(version).success) { diagnostics.push({ resourceId: id, version: null,
            code: 'resource_manifest_invalid', message: 'Invalid resource version directory.' }); continue; }
          const loaded = checked(() => load(kind, id, version));
          if (loaded.ok) packages.push(loaded.data);
          else diagnostics.push({ resourceId: id, version, code: loaded.error.code, message: loaded.error.message });
        }
      }
    }
    return { packages, diagnostics };
  }
  function find(packages: Package[], ref: ResourceRef): Package {
    const pack = packages.find(pack => resourceRefKey(pack.ref) === resourceRefKey(ref));
    if (!pack) {
      if (packages.some(pack => pack.ref.kind === ref.kind && pack.ref.id === ref.id && pack.ref.version === ref.version))
        reject('resource_version_changed', 'The selected resource version now has different content.');
      reject('resource_required_unavailable', 'The selected resource version is unavailable.');
    }
    if (!pack.item.available) {
      const diagnostic = pack.item.diagnostics[0]!;
      throw appError(diagnostic.code, ...errorFacts(diagnostic.code as ResourceErrorCode));
    }
    return pack;
  }
  function dependencies(pack: Package, packages: Package[], selection: ResourceSelection, tools: ReadonlySet<string>,
    availableExtensions: AvailableExtensions = [], visiting = new Set<string>()) {
    const key = resourceRefKey(pack.ref);
    if (visiting.has(key)) reject('resource_dependency_missing', 'Selected Skill dependencies contain a cycle.');
    visiting.add(key);
    for (const dependency of pack.manifest.requires) {
      if (dependency.kind === 'tool') {
        if (!tools.has(dependency.name)) reject('resource_dependency_missing', 'A declared tool is unavailable in this scope.');
      } else if (dependency.kind === 'extension') {
        if (!availableExtensions.some(ref => ref.id === dependency.id && ref.version === dependency.version))
          reject('resource_dependency_missing', 'A declared extension is not explicitly available at this version.');
      }
      else {
        const ref: ResourceRef = { ...dependency, kind: 'skill' };
        if (!selection.enabledSkills.some(item => resourceRefKey(item) === resourceRefKey(ref)))
          reject('resource_dependency_missing', 'A declared Skill dependency is not explicitly enabled at its fixed version.');
        dependencies(find(packages, ref), packages, selection, tools, availableExtensions, visiting);
      }
    }
    visiting.delete(key);
  }
  function readBundle(hash: string): ResourceBundleManifest {
    const raw = bytes(safePath(bundleRoot, `${hash}/bundle.json`), RESOURCE_LIMITS.manifestBytes * RESOURCE_LIMITS.packages * 2 + 65536);
    const manifest = ResourceBundleManifestSchema.parse(JSON.parse(decoder.decode(raw)));
    if (manifest.bundleHash !== hash || bundleHash(manifest.resources.map(item => item.ref)) !== hash
      || manifest.resources.some(item => sha256(canonicalResourceManifest(item.manifest)) !== item.ref.contentHash))
      reject('resource_bundle_unavailable', 'Published bundle identity differs from its content manifests.');
    for (const item of manifest.resources) {
      const copied = ResourceManifestSchema.parse(JSON.parse(decoder.decode(bytes(safePath(join(bundleRoot, hash), `${versionPath(item.ref)}/resource.json`), RESOURCE_LIMITS.manifestBytes))));
      if (sha256(canonicalResourceManifest(copied)) !== item.ref.contentHash)
        reject('resource_bundle_unavailable', 'Published resource manifest no longer matches its original identity.');
    }
    for (const file of manifest.files) {
      const content = bytes(safePath(join(bundleRoot, hash), `${versionPath(file.ref)}/${file.path}`), RESOURCE_LIMITS.fileBytes);
      if (content.length !== file.bytes || sha256(content) !== file.sha256)
        reject('resource_bundle_unavailable', 'Published resource content no longer matches its original identity.');
    }
    return manifest;
  }
  function publish(packages: Package[]): string {
    const hash = bundleHash(packages.map(pack => pack.ref)), target = join(bundleRoot, hash);
    mkdirSync(bundleRoot, { recursive: true }); directory(bundleRoot);
    if (existsSync(target)) { readBundle(hash); return hash; }
    const temporary = join(bundleRoot, `.tmp-${randomUUID()}`);
    mkdirSync(temporary);
    try {
      const manifest = ResourceBundleManifestSchema.parse({ version: 1, bundleHash: hash,
        resources: packages.map(pack => ({ ref: pack.ref, manifest: pack.manifest })),
        files: packages.flatMap(pack => pack.manifest.files.map(file => ({ ref: pack.ref, ...file }))) });
      for (const pack of packages) {
        const root = join(temporary, versionPath(pack.ref)); mkdirSync(root, { recursive: true });
        writeSynced(join(root, 'resource.json'), canonicalResourceManifest(pack.manifest));
        for (const [path, content] of pack.contents) {
          mkdirSync(dirname(join(root, path)), { recursive: true }); writeSynced(join(root, path), content);
        }
      }
      writeSynced(join(temporary, 'bundle.json'), JSON.stringify(manifest));
      // All bytes are complete before the content address becomes visible. Existing bundles are never rewritten.
      if (existsSync(target)) readBundle(hash);
      else try { renameSync(temporary, target); } catch (error) { if (!existsSync(target)) throw error; readBundle(hash); }
      readBundle(hash); return hash;
    } finally {
      if (existsSync(temporary)) { directory(temporary); rmSync(temporary, { recursive: true, force: true }); }
    }
  }
  function frozenBundle(input: FrozenResources) {
    const frozen = FrozenResourcesSchema.parse(input), manifest = readBundle(frozen.bundleHash);
    if (!verifyFrozenResourceMetadata(frozen).ok) reject('resource_bundle_unavailable', 'Frozen metadata is invalid.');
    const expected = [...(frozen.prompt ? [frozen.prompt] : []), ...frozen.discoveredSkills];
    if (manifest.resources.length !== expected.length || expected.some(ref => !manifest.resources.some(item => resourceRefKey(item.ref) === resourceRefKey(ref))))
      reject('resource_bundle_unavailable', 'Run resources and original bundle membership disagree.');
    return manifest;
  }
  function page(input: ResourceFileRequest, ref: ResourceRef, content: Buffer): ResourceFilePage {
    const text = decoder.decode(content); // Binary or invalid UTF-8 is never replaced with a guessed preview.
    const offset = input.offset ?? 0, limit = input.limit ?? RESOURCE_LIMITS.pageBytes;
    if (offset > content.length || offset < content.length && (content[offset]! & 0xc0) === 0x80)
      reject('resource_file_unavailable', 'Text offset must be an existing UTF-8 character boundary.');
    let end = Math.min(content.length, offset + limit);
    while (end < content.length && (content[end]! & 0xc0) === 0x80) end--;
    return { ref, path: input.path, sha256: sha256(content), offset, text: end === content.length && offset === 0 ? text : decoder.decode(content.subarray(offset, end)),
      nextOffset: end === content.length ? null : end, totalBytes: content.length };
  }
  return {
    catalog(input: CatalogInput): Result<ResourceCatalog> { return checked(() => {
      const selection = ResourceSelectionSchema.parse(input.selection), { packages, diagnostics } = discover();
      const items = packages.map(pack => {
        const enabled = (pack.ref.kind === 'prompt' ? selection.prompt && resourceRefKey(selection.prompt) === resourceRefKey(pack.ref)
          : selection.enabledSkills.some(ref => resourceRefKey(ref) === resourceRefKey(pack.ref))) === true;
        const validated = checked(() => { find(packages, pack.ref); dependencies(pack, packages, selection, registeredTools, input.availableExtensions); });
        return { ...pack.item, enabled, available: validated.ok,
          diagnostics: validated.ok ? pack.item.diagnostics : pack.item.diagnostics.length ? pack.item.diagnostics : [{ code: validated.error.code, message: validated.error.message }] };
      });
      for (const ref of [...(selection.prompt ? [selection.prompt] : []), ...selection.enabledSkills]) {
        const found = checked(() => find(packages, ref));
        if (!found.ok) diagnostics.push({ resourceId: ref.id, version: ref.version, code: found.error.code, message: found.error.message });
      }
      return ResourceCatalogSchema.parse({ settingsRevision: input.revision, selection, diagnostics, items });
    }); },
    validateSelection(input: ResourceSelection, availableExtensions: AvailableExtensions = []): Result<void> { return checked(() => {
      const selection = ResourceSelectionSchema.parse(input);
      if (selection.prompt === null && selection.enabledSkills.length === 0) return;
      const { packages } = discover();
      for (const ref of [...(selection.prompt ? [selection.prompt] : []), ...selection.enabledSkills])
        dependencies(find(packages, ref), packages, selection, registeredTools, availableExtensions);
    }); },
    freeze(input: { selection: ResourceSelection; settingsRevision: number; activeToolNames: readonly string[];
      requiredSkill: ResourceRef | null; availableExtensions?: AvailableExtensions }): Result<FrozenResources | null> {
      return checked(() => {
        const selection = ResourceSelectionSchema.parse(input.selection), required = input.requiredSkill === null ? null : ResourceRefSchema.parse(input.requiredSkill);
        if (required && (required.kind !== 'skill' || !selection.enabledSkills.some(ref => resourceRefKey(ref) === resourceRefKey(required))))
          reject('resource_required_unavailable', 'The required Skill is not explicitly enabled at this version.');
        if (selection.prompt === null && selection.enabledSkills.length === 0) return null;
        const { packages } = discover(), tools = new Set(input.activeToolNames.filter(name => registeredTools.has(name))), included: Package[] = [];
        if (selection.prompt) { const prompt = find(packages, selection.prompt); dependencies(prompt, packages, selection, tools, input.availableExtensions); included.push(prompt); }
        const discoveredSkills: ResourceRef[] = [], excludedSkills: Array<{ ref: ResourceRef; code: string }> = [];
        for (const ref of selection.enabledSkills) {
          const selected = checked(() => { const pack = find(packages, ref); dependencies(pack, packages, selection, tools, input.availableExtensions); return pack; });
          if (selected.ok) { included.push(selected.data); discoveredSkills.push(ref); }
          else if (required && resourceRefKey(required) === resourceRefKey(ref)) throw selected.error;
          else excludedSkills.push({ ref, code: selected.error.code });
        }
        const published = checked(() => publish(included), 'resource_bundle_unavailable');
        if (!published.ok) throw appError('resource_bundle_unavailable', ...errorFacts('resource_bundle_unavailable'));
        return FrozenResourcesSchema.parse({ version: 1, policyVersion: 'p11-resources-v1', settingsRevision: input.settingsRevision,
          bundleHash: published.data, bundleDirectory: join(bundleRoot, published.data), prompt: selection.prompt, manifests: included.map(pack => ({ ref: pack.ref, manifest: pack.manifest })),
          selectedSkills: selection.enabledSkills, discoveredSkills, excludedSkills });
      });
    },
    verifyFrozen(input: FrozenResources): Result<void> {
      const verified = checked(() => { frozenBundle(input); }, 'resource_bundle_unavailable');
      return verified.ok ? verified : fail(appError('resource_bundle_unavailable', ...errorFacts('resource_bundle_unavailable')));
    },
    readFile(raw: ResourceFileRequest, input: ResourceSelection, availableExtensions: AvailableExtensions = []): Result<ResourceFilePage> { return checked(() => {
      const request = ResourceFileRequestSchema.parse(raw), selection = ResourceSelectionSchema.parse(input), { packages } = discover();
      if (request.ref.kind === 'skill' && !selection.enabledSkills.some(ref => resourceRefKey(ref) === resourceRefKey(request.ref)))
        reject('resource_required_unavailable', 'Enable this Skill version before requesting its content.');
      const pack = find(packages, request.ref); dependencies(pack, packages, selection, registeredTools, availableExtensions);
      const content = pack.contents.get(request.path);
      if (!content) reject('resource_file_unavailable', 'The requested file is not listed in this version manifest.');
      return page(request, pack.ref, content);
    }, 'resource_file_unavailable'); },
    readFrozenFile(input: FrozenResources, raw: ResourceFileRequest): Result<ResourceFilePage> {
      const verified = checked(() => frozenBundle(input), 'resource_bundle_unavailable');
      if (!verified.ok) return verified;
      return checked(() => {
      const request = ResourceFileRequestSchema.parse(raw), manifest = verified.data;
      const file = manifest.files.find(file => resourceRefKey(file.ref) === resourceRefKey(request.ref) && file.path === request.path);
      if (!file) reject('resource_file_unavailable', 'The requested content does not belong to this original Run bundle.');
      const content = bytes(safePath(join(bundleRoot, input.bundleHash), `${versionPath(file.ref)}/${file.path}`), RESOURCE_LIMITS.fileBytes);
      if (content.length !== file.bytes || sha256(content) !== file.sha256) reject('resource_bundle_unavailable', 'Fixed content changed while being read.');
      return page(request, file.ref, content);
    }, 'resource_file_unavailable'); },
  };
}
