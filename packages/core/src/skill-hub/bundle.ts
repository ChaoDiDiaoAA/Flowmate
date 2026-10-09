import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { appError, fail, RESOURCE_LIMITS, canonicalResourceManifest, FrozenResourcesSchema, ResourceBundleManifestSchema, ResourceFileRequestSchema, ResourceManifestSchema, resourceRefKey } from '@flowmate/contracts';
import type { FrozenResources, ResourceBundleManifest, ResourceFileRequest, ResourceFilePage, ResourceRef, Result } from '@flowmate/contracts';
import type { Package } from './loader.ts';
import { sha256, decoder, compare, checked, reject, errorFacts, directory, safePath, bytes, writeSynced, versionPath, page } from './resources.ts';

const refOrder = (ref: ResourceRef) => JSON.stringify([ref.kind, ref.id, ref.version, ref.contentHash]);
export const bundleHash = (refs: readonly ResourceRef[]) => sha256(JSON.stringify([...refs].sort((a, b) => compare(refOrder(a), refOrder(b)))));
/** Durable Run metadata proves file membership even when the preserved content directory is missing. */
export function verifyFrozenResourceMetadata(value: FrozenResources): Result<void> {
  return checked(() => {
    const frozen = FrozenResourcesSchema.parse(value);
    if (frozen.skillIndex && sha256(JSON.stringify(frozen.skillIndex.entries)) !== frozen.skillIndex.hash)
      reject('resource_evidence_conflict', 'Frozen Skill index identity changed.');
    if (bundleHash(frozen.manifests.map(item => item.ref)) !== frozen.bundleHash
      || frozen.manifests.some(item => sha256(canonicalResourceManifest(item.manifest)) !== item.ref.contentHash))
      reject('resource_evidence_conflict', 'Frozen resource metadata does not match its original content identity.');
  });
}

export function createResourceBundles(path: string) {
  const bundleRoot = resolve(path);
  function readBundle(hash: string): ResourceBundleManifest {
    // Reuse directory checks only within this synchronous verification; every file is still rehashed.
    const directories = new Set<string>();
    const raw = bytes(safePath(bundleRoot, `${hash}/bundle.json`, directories), RESOURCE_LIMITS.manifestBytes * RESOURCE_LIMITS.packages * 2 + 65536);
    const manifest = ResourceBundleManifestSchema.parse(JSON.parse(decoder.decode(raw)));
    if (manifest.bundleHash !== hash || bundleHash(manifest.resources.map(item => item.ref)) !== hash
      || manifest.resources.some(item => sha256(canonicalResourceManifest(item.manifest)) !== item.ref.contentHash))
      reject('resource_bundle_unavailable', 'Published bundle identity differs from its content manifests.');
    for (const item of manifest.resources) {
      const copied = ResourceManifestSchema.parse(JSON.parse(decoder.decode(bytes(safePath(join(bundleRoot, hash), `${versionPath(item.ref)}/resource.json`, directories), RESOURCE_LIMITS.manifestBytes))));
      if (sha256(canonicalResourceManifest(copied)) !== item.ref.contentHash)
        reject('resource_bundle_unavailable', 'Published resource manifest no longer matches its original identity.');
    }
    for (const file of manifest.files) {
      const content = bytes(safePath(join(bundleRoot, hash), `${versionPath(file.ref)}/${file.path}`, directories), RESOURCE_LIMITS.fileBytes);
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

  return { publish,
    verifyFrozen(input: FrozenResources): Result<void> {
      const verified = checked(() => { frozenBundle(input); }, 'resource_bundle_unavailable');
      return verified.ok ? verified : fail(appError('resource_bundle_unavailable', ...errorFacts('resource_bundle_unavailable')));
    },
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
