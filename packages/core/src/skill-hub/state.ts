import { ResourceCatalogSchema, ResourceFileRequestSchema, ResourceSelectionSchema, resourceRefKey } from '@flowmate/contracts';
import type { ResourceCatalog, ResourceFilePage, ResourceFileRequest, ResourceSelection, Result } from '@flowmate/contracts';
import { find, type AvailableExtensions, type CatalogInput, type createResourceLoader } from './loader.ts';
import { dependencies, checkDependency } from './capability-map.ts';
import { checked, reject, page } from './resources.ts';

export function createResourceState(loader: ReturnType<typeof createResourceLoader>, registeredTools: ReadonlySet<string>) {
  const { discover } = loader;
  return {
    catalog(input: CatalogInput): Result<ResourceCatalog> { return checked(() => {
      const selection = ResourceSelectionSchema.parse(input.selection), { packages, diagnostics } = discover();
      const items = packages.map(pack => {
        const enabled = (pack.ref.kind === 'prompt' ? selection.prompt && resourceRefKey(selection.prompt) === resourceRefKey(pack.ref)
          : selection.enabledSkills.some(ref => resourceRefKey(ref) === resourceRefKey(pack.ref))) === true;
        const validated = checked(() => { find(packages, pack.ref); dependencies(pack, packages, selection, registeredTools, input.availableExtensions); });
        const dependencyChecks = pack.manifest.requires.map(dependency => {
          const result = checked(() => checkDependency(dependency, packages, selection, registeredTools,
            input.availableExtensions ?? [], new Set([resourceRefKey(pack.ref)])));
          return { dependency, available: result.ok, reason: result.ok ? null : result.error.message };
        });
        return { ...pack.item, enabled, available: validated.ok, dependencyChecks,
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
    readFile(raw: ResourceFileRequest, input: ResourceSelection, availableExtensions: AvailableExtensions = []): Result<ResourceFilePage> { return checked(() => {
      const request = ResourceFileRequestSchema.parse(raw), selection = ResourceSelectionSchema.parse(input), { packages } = discover();
      if (request.ref.kind === 'skill' && !selection.enabledSkills.some(ref => resourceRefKey(ref) === resourceRefKey(request.ref)))
        reject('resource_required_unavailable', 'Enable this Skill version before requesting its content.');
      const pack = find(packages, request.ref); dependencies(pack, packages, selection, registeredTools, availableExtensions);
      const content = pack.contents.get(request.path);
      if (!content) reject('resource_file_unavailable', 'The requested file is not listed in this version manifest.');
      return page(request, pack.ref, content);
    }, 'resource_file_unavailable'); },
  };
}
