import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appError, RESOURCE_LIMITS, canonicalResourceManifest, ResourceIdSchema, ResourceManifestSchema, ResourceRefSchema, resourceRefKey } from '@flowmate/contracts';
import type { InspectNativeResources, ResourceCatalog, ResourceManifest, ResourceRef, ResourceSelection, ResourceErrorCode, ManagedFileContents } from '@flowmate/contracts';
import { decoder, compare, checked, reject, errorFacts, directory, safePath, bytes } from './resources.ts';

export type Package = { ref: ResourceRef; manifest: ResourceManifest; directory: string; contents: Map<string, Buffer>;
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

export function createResourceLoader(options: { resourceRoot: string; contents: ManagedFileContents; inspectNativeResources: InspectNativeResources }) {
  const authorRoot = resolve(options.resourceRoot);
  function load(kind: 'prompt' | 'skill', id: string): Package {
    const relativeRoot = `${kind === 'prompt' ? 'prompts' : 'skills'}/${id}`;
    const root = join(authorRoot, relativeRoot);
    const manifest = ResourceManifestSchema.parse(JSON.parse(decoder.decode(bytes(safePath(authorRoot,
      `${relativeRoot}/resource.json`), RESOURCE_LIMITS.manifestBytes))));
    if (manifest.kind !== kind || manifest.id !== id)
      reject('resource_name_conflict', 'Resource manifest and registered package directory disagree.');
    const ref = ResourceRefSchema.parse({ kind, id, version: manifest.version });
    const contents = new Map<string, Buffer>();
    const owner = { ownerKind: 'resource-author', ownerId: resourceRefKey(ref) };
    try { options.contents.remember({ ...owner, relativePath: 'resource.json' }, Buffer.from(canonicalResourceManifest(manifest))); }
    catch { reject('resource_version_changed', 'The registered author manifest changed without a new version.'); }
    let name = id, description = '', disableModelInvocation = false;
    const diagnostics: Array<{ code: string; message: string }> = [];
    const verified = checked(() => {
      for (const file of manifest.files) {
        const content = bytes(safePath(root, file.path), RESOURCE_LIMITS.fileBytes);
        if (file.bytes !== content.length)
          reject('resource_version_changed', 'Resource file content differs from its fixed manifest.');
        try { options.contents.remember({ ...owner, relativePath: file.path }, content); }
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
    return { ref, manifest, directory: root, contents, item: { ref, name, description, keywords: manifest.keywords,
      enabled: false, available: diagnostics.length === 0, disableModelInvocation, bodyFile: manifest.bodyFile, files: manifest.files, dependencies: manifest.requires, dependencyChecks: [], diagnostics } };
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
        if (++count > RESOURCE_LIMITS.packages) reject('resource_content_too_large', 'Resource discovery exceeds 64 registered packages.');
        const loaded = checked(() => { directory(join(group, id)); return load(kind, id); });
        if (loaded.ok) packages.push(loaded.data);
        else diagnostics.push({ resourceId: id, version: null, code: loaded.error.code, message: loaded.error.message });
      }
    }
    return { packages, diagnostics };
  }

  return { discover };
}
