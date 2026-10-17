import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { appError, fail, RESOURCE_LIMITS, canonicalResourceManifest, FrozenResourcesSchema, ResourceBundleManifestSchema, ResourceFileRequestSchema, ResourceManifestSchema, resourceRefKey } from '@flowmate/contracts';
import type { FrozenResources, ManagedFileContents, ResourceBundleManifest, ResourceFileRequest, ResourceFilePage, Result } from '@flowmate/contracts';
import type { Package } from './loader.ts';
import { decoder, checked, reject, errorFacts, directory, safePath, bytes, writeSynced, versionPath, page } from './resources.ts';

export function verifyFrozenResourceMetadata(value: FrozenResources): Result<void> {
  return checked(() => { FrozenResourcesSchema.parse(value); });
}

export function createResourceBundles(path: string, contents: ManagedFileContents) {
  const bundleRoot = resolve(path);
  let previous: { bundleId: string; packages: Package[]; skillIndex: FrozenResources['skillIndex'] } | null = null;
  function original(bundleId: string, relativePath: string, content: Buffer) {
    const saved = contents.read({ ownerKind: 'resource-bundle', ownerId: bundleId, relativePath });
    if (saved === null || !content.equals(Buffer.from(saved)))
      reject('resource_bundle_unavailable', 'Published resource content differs from its registered original.');
    return content;
  }
  function readBundle(bundleId: string, verifyFiles: boolean): ResourceBundleManifest {
    const directories = new Set<string>();
    const raw = original(bundleId, 'bundle.json', bytes(safePath(bundleRoot, `${bundleId}/bundle.json`, directories), RESOURCE_LIMITS.manifestBytes * RESOURCE_LIMITS.packages * 2 + 65536));
    const manifest = ResourceBundleManifestSchema.parse(JSON.parse(decoder.decode(raw)));
    if (manifest.bundleId !== bundleId) reject('resource_bundle_unavailable', 'Published bundle identity differs from its registered location.');
    for (const item of manifest.resources) {
      const relativePath = `${versionPath(item.ref)}/resource.json`;
      const raw = original(bundleId, relativePath, bytes(safePath(join(bundleRoot, bundleId), relativePath, directories), RESOURCE_LIMITS.manifestBytes));
      const copied = ResourceManifestSchema.parse(JSON.parse(decoder.decode(raw)));
      if (canonicalResourceManifest(copied) !== canonicalResourceManifest(item.manifest))
        reject('resource_bundle_unavailable', 'Published resource metadata differs from the bundle.');
    }
    if (verifyFiles) for (const file of manifest.files) {
      const relativePath = `${versionPath(file.ref)}/${file.path}`;
      const content = original(bundleId, relativePath, bytes(safePath(join(bundleRoot, bundleId), relativePath, directories), RESOURCE_LIMITS.fileBytes));
      if (content.length !== file.bytes) reject('resource_bundle_unavailable', 'Published resource size differs from its manifest.');
    }
    return manifest;
  }
  function publish(packages: Package[], skillIndex: FrozenResources['skillIndex']): string {
    if (previous && isDeepStrictEqual(previous.packages, packages) && isDeepStrictEqual(previous.skillIndex, skillIndex)) {
      readBundle(previous.bundleId, true);
      return previous.bundleId;
    }
    const bundleId = randomUUID(), target = join(bundleRoot, bundleId);
    mkdirSync(bundleRoot, { recursive: true }); directory(bundleRoot);
    const temporary = join(bundleRoot, `.tmp-${randomUUID()}`);
    mkdirSync(temporary);
    try {
      const manifest = ResourceBundleManifestSchema.parse({ version: 2, bundleId, skillIndex,
        resources: packages.map(pack => ({ ref: pack.ref, manifest: pack.manifest })),
        files: packages.flatMap(pack => pack.manifest.files.map(file => ({ ref: pack.ref, ...file }))) });
      const write = (relativePath: string, content: string | Uint8Array) => {
        mkdirSync(dirname(join(temporary, relativePath)), { recursive: true });
        writeSynced(join(temporary, relativePath), content);
        contents.remember({ ownerKind: 'resource-bundle', ownerId: bundleId, relativePath }, typeof content === 'string' ? Buffer.from(content) : content);
      };
      for (const pack of packages) {
        write(`${versionPath(pack.ref)}/resource.json`, canonicalResourceManifest(pack.manifest));
        for (const [path, content] of pack.contents) write(`${versionPath(pack.ref)}/${path}`, content);
      }
      write('bundle.json', JSON.stringify(manifest));
      if (existsSync(target)) reject('resource_bundle_unavailable', 'The publication ID is already in use.');
      renameSync(temporary, target);
      readBundle(bundleId, true);
      previous = { bundleId, packages, skillIndex };
      return bundleId;
    } finally {
      if (existsSync(temporary)) { directory(temporary); rmSync(temporary, { recursive: true, force: true }); }
    }
  }
  function frozenBundle(input: FrozenResources, verifyFiles: boolean) {
    const frozen = FrozenResourcesSchema.parse(input), manifest = readBundle(frozen.bundleId, verifyFiles);
    const expected = [...(frozen.prompt ? [frozen.prompt] : []), ...frozen.discoveredSkills];
    if (manifest.resources.length !== expected.length || expected.some(ref => !manifest.resources.some(item => resourceRefKey(item.ref) === resourceRefKey(ref)))
      || JSON.stringify(manifest.resources) !== JSON.stringify(frozen.manifests)
      || JSON.stringify(manifest.skillIndex) !== JSON.stringify(frozen.skillIndex))
      reject('resource_bundle_unavailable', 'Run resources and original bundle metadata disagree.');
    return manifest;
  }
  return { publish,
    verifyPublished(bundleId: string): Result<void> {
      return checked(() => { readBundle(bundleId, true); }, 'resource_bundle_unavailable');
    },
    verifyFrozen(input: FrozenResources): Result<void> {
      const verified = checked(() => { frozenBundle(input, true); }, 'resource_bundle_unavailable');
      return verified.ok ? verified : fail(appError('resource_bundle_unavailable', ...errorFacts('resource_bundle_unavailable')));
    },
    readFrozenFile(input: FrozenResources, raw: ResourceFileRequest): Result<ResourceFilePage> {
      return checked(() => {
        const request = ResourceFileRequestSchema.parse(raw), manifest = frozenBundle(input, false);
        const file = manifest.files.find(file => resourceRefKey(file.ref) === resourceRefKey(request.ref) && file.path === request.path);
        if (!file) reject('resource_file_unavailable', 'The requested content does not belong to this original Run bundle.');
        const relativePath = `${versionPath(file.ref)}/${file.path}`;
        const content = original(input.bundleId, relativePath, bytes(safePath(join(bundleRoot, input.bundleId), relativePath), RESOURCE_LIMITS.fileBytes));
        return page(request, file.ref, content);
      }, 'resource_file_unavailable');
    },
  };
}
