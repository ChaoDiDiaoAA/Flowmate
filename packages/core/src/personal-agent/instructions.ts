import { isDeepStrictEqual } from 'node:util';
import { appError, fail, ok, FrozenResourcesSchema, PersonalAgentConfigurationSchema, RESOURCE_LIMITS,
  ResourceFilePageSchema, resourceRefKey, type FrozenResources, type PersonalAgentConfiguration,
  type ResourceFilePage, type ResourceFileRequest, type ResourceRef, type Result } from '@flowmate/contracts';
import { InvoiceWorkPhaseInstructionsSchema, type InvoiceWorkPhaseInstructions } from '../../../contracts/src/personal-context.ts';

/** Reads only original bodies from an already assembled, explicitly selected resource bundle. */
export function prepareInvoiceWorkInstructions(input: { configuration: PersonalAgentConfiguration; resources: FrozenResources | null;
  readFrozenFile: (frozen: FrozenResources, request: ResourceFileRequest) => Result<ResourceFilePage> }): Result<InvoiceWorkPhaseInstructions> {
  const configuration = PersonalAgentConfigurationSchema.safeParse(input.configuration);
  if (!configuration.success) return fail(appError('input_invalid', 'input', 'The original Personal Agent configuration is invalid.'));
  const config = configuration.data;
  if (config.extensions.enabledExtensions.length)
    return fail(appError('personal_agent_extensions_unavailable', 'runtime', 'Durable phase instructions cannot activate selected extensions.'));
  const base = { version: 1 as const, role: 'invoice-master' as const, provenance: 'phase-instructions' as const, preferences: config.preferences };
  if (input.resources === null) return config.resources.prompt === null && config.resources.enabledSkills.length === 0
    ? ok({ ...base, resources: null }) : fail(appError('resource_required_unavailable', 'runtime', 'The selected instruction resource versions are unavailable.'));
  const parsed = FrozenResourcesSchema.safeParse(input.resources);
  if (!parsed.success) return fail(appError('resource_bundle_unavailable', 'runtime', 'The original instruction bundle is invalid.'));
  const frozen = parsed.data;
  if (!isDeepStrictEqual(frozen.prompt, config.resources.prompt) || !isDeepStrictEqual(frozen.selectedSkills, config.resources.enabledSkills)
    || frozen.excludedSkills.length || !isDeepStrictEqual(frozen.discoveredSkills, config.resources.enabledSkills))
    return fail(appError('resource_required_unavailable', 'runtime', 'Every selected instruction resource must use its original available version.'));
  function readBody(ref: ResourceRef): Result<{ ref: ResourceRef; path: 'prompt.md' | 'SKILL.md'; text: string }> {
    const path = ref.kind === 'prompt' ? 'prompt.md' : 'SKILL.md';
    const manifest = frozen.manifests.find(item => resourceRefKey(item.ref) === resourceRefKey(ref))?.manifest;
    const body = manifest?.files.find(file => file.path === path);
    if (!manifest || manifest.bodyFile !== path || !body || body.bytes > RESOURCE_LIMITS.bodyBytes)
      return fail(appError('resource_file_unavailable', 'runtime', 'The original instruction body is unavailable.'));
    let offset = 0, text = '';
    do {
      const result = input.readFrozenFile(frozen, { ref, path, offset, limit: RESOURCE_LIMITS.pageBytes });
      if (!result.ok) return result;
      const page = ResourceFilePageSchema.safeParse(result.data);
      if (!page.success || resourceRefKey(page.data.ref) !== resourceRefKey(ref) || page.data.path !== path
        || page.data.offset !== offset || page.data.totalBytes !== body.bytes
        || new TextEncoder().encode(page.data.text).byteLength !== (page.data.nextOffset ?? body.bytes) - offset)
        return fail(appError('resource_file_unavailable', 'runtime', 'The original instruction body page is inconsistent.'));
      text += page.data.text;
      if (page.data.nextOffset === null) break;
      offset = page.data.nextOffset;
    } while (offset < body.bytes);
    return ok({ ref, path, text });
  }
  try {
    const prompt = frozen.prompt === null ? ok(null) : readBody(frozen.prompt);
    if (!prompt.ok) return prompt;
    const skills = [];
    for (const ref of frozen.discoveredSkills) {
      const body = readBody(ref); if (!body.ok) return body;
      skills.push(body.data);
    }
    const prepared = InvoiceWorkPhaseInstructionsSchema.safeParse({ ...base,
      resources: { bundleId: frozen.bundleId, prompt: prompt.data, skills } });
    return prepared.success ? ok(prepared.data)
      : fail(appError('resource_content_too_large', 'runtime', 'The selected instruction bodies are invalid or exceed their UTF-8 limits.'));
  } catch { return fail(appError('resource_file_unavailable', 'runtime', 'The original instruction bodies could not be read.')); }
}
