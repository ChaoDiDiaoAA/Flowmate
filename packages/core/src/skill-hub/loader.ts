import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appError, RESOURCE_LIMITS, canonicalResourceManifest, ResourceIdSchema, ResourceManifestSchema, ResourceRefSchema, resourceRefKey } from '@flowmate/contracts';
import type { InspectNativeResources, ResourceCatalog, ResourceManifest, ResourceRef, ResourceSelection, ResourceErrorCode, ManagedFileContents } from '@flowmate/contracts';
import { decoder, compare, checked, reject, errorFacts, directory, safePath, bytes } from './resources.ts';

export type Package = { ref: ResourceRef; manifest: ResourceManifest; manifestBytes: Buffer; directory: string; contents: Map<string, Buffer>;
  item: ResourceCatalog['items'][number] };
export type AvailableExtensions = readonly { id: string; version: string }[];
export type CatalogInput = { revision: number; selection: ResourceSelection; availableExtensions?: AvailableExtensions };


export function find<T extends Pick<Package, 'ref'> & { item?: Package['item'] }>(packages: readonly T[], ref: ResourceRef): T {
  const pack = packages.find(pack => resourceRefKey(pack.ref) === resourceRefKey(ref));
  if (!pack) {
    reject('resource_required_unavailable', 'The selected resource version is unavailable.');
  }
  if (pack.item && !pack.item.available) {
    const diagnostic = pack.item.diagnostics[0]!;
    throw appError(diagnostic.code, ...errorFacts(diagnostic.code as ResourceErrorCode));
  }
  return pack;
}

export function createResourceLoader(options: { resourceRoot: string; importedResourceRoot?: string; contents?: ManagedFileContents; inspectNativeResources: InspectNativeResources }) {
  const authorRoot = resolve(options.resourceRoot);
  function load(sourceRoot: string, relativeRoot: string, kind: 'prompt' | 'skill', id: string, store: ManagedFileContents, version?: string): Package {
    const root = join(sourceRoot, relativeRoot);
    const manifestBytes = bytes(safePath(sourceRoot, `${relativeRoot}/resource.json`), RESOURCE_LIMITS.manifestBytes);
    const manifest = ResourceManifestSchema.parse(JSON.parse(decoder.decode(manifestBytes)));
    if (manifest.kind !== kind || manifest.id !== id || version !== undefined && manifest.version !== version)
      reject('resource_name_conflict', 'Resource manifest and registered package directory disagree.');
    const ref = ResourceRefSchema.parse({ kind, id, version: manifest.version });
    const originalManifest = store.read({ ownerKind: 'cloud-resource-manifest', ownerId: resourceRefKey(ref), relativePath: 'resource.json' });
    if (version !== undefined && !originalManifest || originalManifest && !Buffer.from(originalManifest).equals(manifestBytes))
      reject('resource_version_changed', 'The uploaded resource manifest bytes changed.');
    const contents = new Map<string, Buffer>();
    const owner = { ownerKind: 'resource-author', ownerId: resourceRefKey(ref) };
    const canonical = Buffer.from(canonicalResourceManifest(manifest));
    const originalCanonical = store.read({ ...owner, relativePath: 'resource.json' });
    if (version !== undefined && (!originalCanonical || !Buffer.from(originalCanonical).equals(canonical)))
      reject('resource_version_changed', 'The uploaded resource manifest record is unavailable.');
    try { store.remember({ ...owner, relativePath: 'resource.json' }, canonical); }
    catch { reject('resource_version_changed', 'The registered author manifest changed without a new version.'); }
    let name = id, description = '', disableModelInvocation = false;
    const diagnostics: Array<{ code: string; message: string }> = [];
    const verified = checked(() => {
      for (const file of manifest.files) {
        const content = bytes(safePath(root, file.path), RESOURCE_LIMITS.fileBytes);
        if (file.bytes !== content.length)
          reject('resource_version_changed', 'Resource file content differs from its fixed manifest.');
        const original = store.read({ ...owner, relativePath: file.path });
        if (version !== undefined && (!original || !Buffer.from(original).equals(content)))
          reject('resource_version_changed', 'The uploaded resource file bytes changed.');
        try { store.remember({ ...owner, relativePath: file.path }, content); }
        catch { reject('resource_version_changed', 'The registered author content changed without a new version.'); }
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
        if (!bytes(safePath(root, manifest.bodyFile), RESOURCE_LIMITS.bodyBytes).equals(contents.get(manifest.bodyFile)!))
          reject('resource_version_changed', 'Skill body changed during native discovery.');
      }
    });
    if (!verified.ok) diagnostics.push({ code: verified.error.code, message: verified.error.message });
    return { ref, manifest, manifestBytes, directory: root, contents, item: { ref, name, description, keywords: manifest.keywords,
      enabled: false, available: diagnostics.length === 0, disableModelInvocation, bodyFile: manifest.bodyFile, files: manifest.files, dependencies: manifest.requires, dependencyChecks: [], diagnostics } };
  }
  function discover(contents: ManagedFileContents | undefined = options.contents) {
    if (!contents) reject('resource_bundle_unavailable', 'Original resource contents are required.');
    const packages: Package[] = [], diagnostics: ResourceCatalog['diagnostics'][number][] = [];
    const conflicts = new Set<string>();
    let count = 0;
    const register = (sourceRoot: string, relativeRoot: string, kind: 'prompt' | 'skill', id: string, version?: string) => {
      if (++count > RESOURCE_LIMITS.packages) reject('resource_content_too_large', 'Resource discovery exceeds 64 registered packages.');
      const loaded = checked(() => { directory(join(sourceRoot, relativeRoot)); return load(sourceRoot, relativeRoot, kind, id, contents, version); });
      const key = version === undefined ? loaded.ok ? resourceRefKey(loaded.data.ref) : null : resourceRefKey({ kind, id, version });
      const previous = key === null ? -1 : packages.findIndex(item => resourceRefKey(item.ref) === key);
      if (!loaded.ok) {
        if (previous >= 0) { packages.splice(previous, 1); conflicts.add(key!); }
        diagnostics.push({ resourceId: id, version: version ?? null, code: loaded.error.code, message: loaded.error.message }); return;
      }
      if (key === null || conflicts.has(key)) return;
      if (previous < 0) { packages.push(loaded.data); return; }
      const before = packages[previous]!, after = loaded.data;
      const equal = before.manifestBytes.equals(after.manifestBytes) && before.contents.size === after.contents.size
        && [...before.contents].every(([path, content]) => after.contents.get(path)?.equals(content));
      if (!equal) {
        packages.splice(previous, 1); conflicts.add(key);
        diagnostics.push({ resourceId: id, version: after.ref.version, code: 'resource_version_changed', message: 'The same resource version has different original bytes.' });
      }
    };
    for (const [sourceRoot, versioned] of [[authorRoot, false], ...(options.importedResourceRoot ? [[resolve(options.importedResourceRoot), true] as const] : [])] as const) {
      if (!existsSync(sourceRoot)) continue;
      directory(sourceRoot);
      for (const kind of ['prompt', 'skill'] as const) {
        const groupName = kind === 'prompt' ? 'prompts' : 'skills', group = join(sourceRoot, groupName);
        if (!existsSync(group)) continue;
        const entries = checked(() => { directory(group); return readdirSync(group).sort(compare); });
        if (!entries.ok) { diagnostics.push({ resourceId: null, version: null, code: entries.error.code, message: `${kind}: ${entries.error.message}` }); continue; }
        for (const id of entries.data) {
          if (!ResourceIdSchema.safeParse(id).success) { diagnostics.push({ resourceId: null, version: null,
            code: 'resource_manifest_invalid', message: 'Invalid resource directory ID.' }); continue; }
          if (!versioned) { register(sourceRoot, `${groupName}/${id}`, kind, id); continue; }
          const versions = checked(() => { const path = join(group, id); directory(path); return readdirSync(path).sort(compare); });
          if (!versions.ok) { diagnostics.push({ resourceId: id, version: null, code: versions.error.code, message: versions.error.message }); continue; }
          for (const version of versions.data) {
            if (!ResourceIdSchema.safeParse(version).success) { diagnostics.push({ resourceId: id, version: null,
              code: 'resource_manifest_invalid', message: 'Invalid imported resource version.' }); continue; }
            register(sourceRoot, `${groupName}/${id}/${version}`, kind, id, version);
          }
        }
      }
    }
    return { packages, diagnostics };
  }

  function author(raw: ResourceRef, contents: ManagedFileContents | undefined = options.contents) {
    return checked(() => {
      if (!contents) reject('resource_bundle_unavailable', 'Original resource contents are required.');
      const ref = ResourceRefSchema.parse(raw), relativeRoot = `${ref.kind === 'prompt' ? 'prompts' : 'skills'}/${ref.id}`;
      directory(authorRoot); directory(join(authorRoot, relativeRoot));
      return find([load(authorRoot, relativeRoot, ref.kind, ref.id, contents)], ref);
    });
  }
  return { discover, author };
}
