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

export function captureFrozenResourceContents(input: FrozenResources | null,
  contents: Pick<ManagedFileContents, 'read'>): Result<Pick<ManagedFileContents, 'read'>> {
  return checked(() => {
    const frozen = input === null ? null : FrozenResourcesSchema.parse(input), originals = new Map<string, Uint8Array>();
    if (frozen) {
      const paths = new Set(['bundle.json', ...frozen.manifests.flatMap(item => [
        `${versionPath(item.ref)}/resource.json`, ...item.manifest.files.map(file => `${versionPath(item.ref)}/${file.path}`),
      ])]);
      for (const relativePath of paths) {
        const original = contents.read({ ownerKind: 'resource-bundle', ownerId: frozen.bundleId, relativePath });
        if (original === null) reject('resource_bundle_unavailable', 'Original bundle bytes are unavailable.');
        originals.set(relativePath, Uint8Array.from(original));
      }
    }
    const bundleId = frozen?.bundleId;
    return { read(owner) {
      if (!bundleId || owner.ownerKind !== 'resource-bundle' || owner.ownerId !== bundleId) return null;
      const original = originals.get(owner.relativePath);
      return original === undefined ? null : Uint8Array.from(original);
    } };
  }, 'resource_bundle_unavailable');
}

export function createResourceBundles(path: string, contents?: ManagedFileContents) {
  const bundleRoot = resolve(path);
  let previous: { bundleId: string; packages: Package[]; skillIndex: FrozenResources['skillIndex'] } | null = null;
  function original(bundleId: string, relativePath: string, content: Buffer, currentContents: ManagedFileContents | undefined = contents) {
    if (!currentContents) reject('resource_bundle_unavailable', 'Original bundle contents are required.');
    const saved = currentContents.read({ ownerKind: 'resource-bundle', ownerId: bundleId, relativePath });
    if (saved === null || !content.equals(Buffer.from(saved)))
      reject('resource_bundle_unavailable', 'Published resource content differs from its registered original.');
    return content;
  }
  function readBundle(bundleId: string, verifyFiles: boolean, currentContents: ManagedFileContents | undefined = contents): ResourceBundleManifest {
    const directories = new Set<string>();
    const raw = original(bundleId, 'bundle.json', bytes(safePath(bundleRoot, `${bundleId}/bundle.json`, directories), RESOURCE_LIMITS.manifestBytes * RESOURCE_LIMITS.packages * 2 + 65536), currentContents);
    const manifest = ResourceBundleManifestSchema.parse(JSON.parse(decoder.decode(raw)));
    if (manifest.bundleId !== bundleId) reject('resource_bundle_unavailable', 'Published bundle identity differs from its registered location.');
    for (const item of manifest.resources) {
      const relativePath = `${versionPath(item.ref)}/resource.json`;
      const raw = original(bundleId, relativePath, bytes(safePath(join(bundleRoot, bundleId), relativePath, directories), RESOURCE_LIMITS.manifestBytes), currentContents);
      const copied = ResourceManifestSchema.parse(JSON.parse(decoder.decode(raw)));
      if (canonicalResourceManifest(copied) !== canonicalResourceManifest(item.manifest))
        reject('resource_bundle_unavailable', 'Published resource metadata differs from the bundle.');
    }
    if (verifyFiles) for (const file of manifest.files) {
      const relativePath = `${versionPath(file.ref)}/${file.path}`;
      const content = original(bundleId, relativePath, bytes(safePath(join(bundleRoot, bundleId), relativePath, directories), RESOURCE_LIMITS.fileBytes), currentContents);
      if (content.length !== file.bytes) reject('resource_bundle_unavailable', 'Published resource size differs from its manifest.');
    }
    return manifest;
  }
  function publish(packages: Package[], skillIndex: FrozenResources['skillIndex'], currentContents: ManagedFileContents | undefined = contents): string {
    if (!currentContents) reject('resource_bundle_unavailable', 'Original bundle contents are required.');
    if (previous && isDeepStrictEqual(previous.packages, packages) && isDeepStrictEqual(previous.skillIndex, skillIndex)) {
      readBundle(previous.bundleId, true, currentContents);
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
        currentContents.remember({ ownerKind: 'resource-bundle', ownerId: bundleId, relativePath }, typeof content === 'string' ? Buffer.from(content) : content);
      };
      for (const pack of packages) {
        write(`${versionPath(pack.ref)}/resource.json`, canonicalResourceManifest(pack.manifest));
        for (const [path, content] of pack.contents) write(`${versionPath(pack.ref)}/${path}`, content);
      }
      write('bundle.json', JSON.stringify(manifest));
      if (existsSync(target)) reject('resource_bundle_unavailable', 'The publication ID is already in use.');
      renameSync(temporary, target);
      readBundle(bundleId, true, currentContents);
      previous = { bundleId, packages, skillIndex };
      return bundleId;
    } finally {
      if (existsSync(temporary)) { directory(temporary); rmSync(temporary, { recursive: true, force: true }); }
    }
  }
  function frozenBundle(input: FrozenResources, verifyFiles: boolean, currentContents: ManagedFileContents | undefined = contents) {
    const frozen = FrozenResourcesSchema.parse(input), manifest = readBundle(frozen.bundleId, verifyFiles, currentContents);
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
    verifyFrozen(input: FrozenResources, currentContents: ManagedFileContents | undefined = contents): Result<void> {
      const verified = checked(() => { frozenBundle(input, true, currentContents); }, 'resource_bundle_unavailable');
      return verified.ok ? verified : fail(appError('resource_bundle_unavailable', ...errorFacts('resource_bundle_unavailable')));
    },
    readFrozenFile(input: FrozenResources, raw: ResourceFileRequest, currentContents: ManagedFileContents | undefined = contents): Result<ResourceFilePage> {
      return checked(() => {
        const request = ResourceFileRequestSchema.parse(raw), manifest = frozenBundle(input, false, currentContents);
        const file = manifest.files.find(file => resourceRefKey(file.ref) === resourceRefKey(request.ref) && file.path === request.path);
        if (!file) reject('resource_file_unavailable', 'The requested content does not belong to this original Run bundle.');
        const relativePath = `${versionPath(file.ref)}/${file.path}`;
        const content = original(input.bundleId, relativePath, bytes(safePath(join(bundleRoot, input.bundleId), relativePath), RESOURCE_LIMITS.fileBytes), currentContents);
        return page(request, file.ref, content);
      }, 'resource_file_unavailable');
    },
  };
}
