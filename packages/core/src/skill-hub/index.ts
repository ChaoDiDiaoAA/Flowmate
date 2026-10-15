import { join, resolve } from 'node:path';
import { appError, FrozenResourcesSchema, ExtensionAssemblyEvidenceSchema, ListSkillResourcesInputSchema, ReadSkillResourceInputSchema,
  ResourceRefSchema, ResourceSelectionSchema, SkillIndexEntrySchema, resourceRefKey } from '@flowmate/contracts';
import type { FrozenResources, InspectNativeResources, ResourceRef, ResourceSelection, Result, RunSnapshot, ProductToolContext,
  ListSkillResourcesInput, ListSkillResourcesOutput, ReadSkillResourceInput, ReadSkillResourceOutput, ManagedFileContents } from '@flowmate/contracts';
import { createResourceLoader, find, type AvailableExtensions, type Package } from './loader.ts';
import { dependencies, checkDependency, visibleFrozenSkills } from './capability-map.ts';
import { createResourceState } from './state.ts';
import { createResourceBundles } from './bundle.ts';
import { checked, reject, errorFacts } from './resources.ts';
export { resolveRequiredSkill } from './router.ts';
export { verifyFrozenResourceMetadata } from './bundle.ts';
export { visibleFrozenSkills } from './capability-map.ts';

export function createResourceService(options: { resourceRoot: string; bundleRoot: string; contents: ManagedFileContents;
  registeredToolNames: readonly string[]; inspectNativeResources: InspectNativeResources;
  getRun?: (runId: number) => Result<RunSnapshot> }) {
  const loader = createResourceLoader(options), { discover } = loader;
  const registeredTools = new Set(options.registeredToolNames), bundleRoot = resolve(options.bundleRoot);
  const bundles = createResourceBundles(bundleRoot, options.contents), { publish } = bundles;
  function ownedSkill(skill: string, tool: string, context: ProductToolContext) {
    const loaded = options.getRun?.(context.runId);
    if (!loaded) reject('resource_required_unavailable', 'Skill tools require an owned Run.');
    if (!loaded.ok) throw loaded.error;
    const run = loaded.data;
    if (run.kind === 'provider' || run.sessionId !== context.sessionId || run.status !== 'running' || run.cancelRequestedAt !== null
      || !('allowedTools' in run.scope) || !run.scope.allowedTools.includes(tool) || JSON.stringify(run.scope) !== JSON.stringify(context.scope))
      reject('resource_required_unavailable', 'Skill tools require their active owner and allowed scope.');
    const frozen = FrozenResourcesSchema.parse(run.config.resources);
    const assembly = ExtensionAssemblyEvidenceSchema.safeParse(run.config.extensionAssembly);
    const visible = visibleFrozenSkills(frozen, run.scope.allowedTools, run.kind === 'subagent' ? [] : assembly.success ? assembly.data.instances.map(item => item.ref) : []);
    const ref = visible.find(ref => ref.id === skill);
    if (!ref) reject('resource_required_unavailable', 'This Skill is not available in the original Run scope.');
    return { frozen, ref, manifest: find(frozen.manifests, ref).manifest };
  }
  return {
    ...createResourceState(loader, registeredTools),
    verifyFrozen: bundles.verifyFrozen,
    readFrozenFile: bundles.readFrozenFile,
    listSkillResources(raw: ListSkillResourcesInput, context: ProductToolContext): Result<ListSkillResourcesOutput> { return checked(() => {
      const input = ListSkillResourcesInputSchema.parse(raw), { frozen, ref, manifest } = ownedSkill(input.skill, 'list_skill_resources', context);
      const verified = bundles.verifyFrozen(frozen); if (!verified.ok) throw verified.error;
      return { ref, bundleId: frozen.bundleId, files: [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) };
    }); },
    readSkillResource(raw: ReadSkillResourceInput, context: ProductToolContext): Result<ReadSkillResourceOutput> { return checked(() => {
      const input = ReadSkillResourceInputSchema.parse(raw), { frozen, ref } = ownedSkill(input.skill, 'read_skill_resource', context);
      const value = bundles.readFrozenFile(frozen, { ref, path: input.path, ...(input.offset === undefined ? {} : { offset: input.offset }),
        ...(input.limit === undefined ? {} : { limit: input.limit }) });
      if (!value.ok) throw value.error;
      return { ...value.data, ref: { ...ref, kind: 'skill' as const }, bundleId: frozen.bundleId };
    }, 'resource_file_unavailable'); },
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
        const entries = selection.enabledSkills.map(ref => {
          const pack = packages.find(pack => resourceRefKey(pack.ref) === resourceRefKey(ref));
          return SkillIndexEntrySchema.parse({ ref, description: pack?.item.description.slice(0, 160) ?? '',
            diagnostic: pack?.item.diagnostics[0]?.message ?? (pack ? null : 'The fixed author version is unavailable.'),
            checks: (pack?.manifest.requires ?? []).map(dependency => {
              const result = checked(() => checkDependency(dependency, packages, selection, tools, input.availableExtensions ?? [], new Set([resourceRefKey(ref)])));
              return { dependency, available: result.ok, reason: result.ok ? null : result.error.message };
            }) });
        });
        const published = checked(() => publish(included, { entries }), 'resource_bundle_unavailable');
        if (!published.ok) throw appError('resource_bundle_unavailable', ...errorFacts('resource_bundle_unavailable'));
        return FrozenResourcesSchema.parse({ version: 2, policyVersion: 'p11-resources-v1', settingsRevision: input.settingsRevision,
          bundleId: published.data, bundleDirectory: join(bundleRoot, published.data), prompt: selection.prompt, manifests: included.map(pack => ({ ref: pack.ref, manifest: pack.manifest })),
          selectedSkills: selection.enabledSkills, discoveredSkills, excludedSkills,
          skillIndex: { entries } });
      });
    },
  };
}
