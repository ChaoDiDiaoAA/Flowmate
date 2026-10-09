import { resourceRefKey } from '@flowmate/contracts';
import type { FrozenResources, ResourceDependency, ResourceRef, ResourceSelection } from '@flowmate/contracts';
import { find, type Package, type AvailableExtensions } from './loader.ts';
import { checked, reject } from './resources.ts';

type DependencyPackage = Pick<Package, 'ref' | 'manifest'> & { item?: Package['item'] };

export function dependencies(pack: DependencyPackage, packages: readonly DependencyPackage[], selection: ResourceSelection, tools: ReadonlySet<string>,
  availableExtensions: AvailableExtensions = [], visiting = new Set<string>()) {
  const key = resourceRefKey(pack.ref);
  if (visiting.has(key)) reject('resource_dependency_missing', 'Selected Skill dependencies contain a cycle.');
  visiting.add(key);
  try { for (const dependency of pack.manifest.requires)
    checkDependency(dependency, packages, selection, tools, availableExtensions, visiting);
  } finally { visiting.delete(key); }
}
export function checkDependency(dependency: ResourceDependency, packages: readonly DependencyPackage[], selection: ResourceSelection,
  tools: ReadonlySet<string>, availableExtensions: AvailableExtensions, visiting: Set<string>) {
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

export function visibleFrozenSkills(frozen: FrozenResources, tools: readonly string[], extensions: AvailableExtensions = []): ResourceRef[] {
  const selection = { prompt: frozen.prompt, enabledSkills: frozen.discoveredSkills };
  return frozen.discoveredSkills.filter(ref => checked(() =>
    dependencies(find(frozen.manifests, ref), frozen.manifests, selection, new Set(tools), extensions)).ok);
}
