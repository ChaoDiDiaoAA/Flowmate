import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { AppErrorSchema, ExtensionManifestSchema, ExtensionSelectionSchema, ExtensionCatalogItemSchema,
  FrozenExtensionsSchema, ExtensionEvaluationProfileSchema, extensionRefKey, appError, ok, fail } from '@flowmate/contracts';
import type { ExtensionCatalogItem, ExtensionSelection, ExtensionEvaluationProfile, FrozenExtensions, Result, ToolDefinition } from '@flowmate/contracts';

function checked<T>(action: () => T): Result<T> {
  try { return ok(action()); }
  catch (error) {
    const parsed = AppErrorSchema.safeParse(error);
    return fail(parsed.success ? parsed.data : appError('extension_config_invalid', 'input', 'The trusted extension manifest or selection is invalid.'));
  }
}
export function createExtensionService(options: { resourceRoot: string; sdkVersion: string;
  registeredTools: readonly Pick<ToolDefinition<any, any>, 'name' | 'version' | 'effect'>[]; evaluationProfile?: ExtensionEvaluationProfile }) {
  const root = resolve(options.resourceRoot), files = ['invoice-v1.json', 'subagents-v1.json'] as const;
  const evaluationProfile = options.evaluationProfile === undefined ? undefined : ExtensionEvaluationProfileSchema.parse(options.evaluationProfile);
  function read(name: typeof files[number]): ExtensionCatalogItem {
    const file = join(root, 'extensions', name);
    const location = relative(realpathSync(root), realpathSync(file)).replaceAll('\\', '/');
    if ((process.platform === 'win32' ? location.toLowerCase() : location) !== `extensions/${name}`)
      throw appError('extension_config_invalid', 'input', 'The extension manifest is outside its trusted fixed location.');
    const fd = openSync(file, 'r');
    let text: string;
    try {
      const stat = fstatSync(fd), data = Buffer.alloc(65537);
      if (!stat.isFile() || stat.size > 65536) throw new Error('bounded manifest');
      let size = 0, read = 0;
      while (size < data.length && (read = readSync(fd, data, size, data.length - size, null)) > 0) size += read;
      if (size > 65536) throw new Error('bounded manifest');
      text = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, size));
    } finally { closeSync(fd); }
    const manifest = ExtensionManifestSchema.parse(JSON.parse(text));
    if (manifest.id !== (name === 'invoice-v1.json' ? 'invoice-assist' : 'subagents')) throw new Error('manifest identity');
    const code = options.sdkVersion !== manifest.sdkVersion ? 'sdk_version_mismatch' as const
      : manifest.tools.some(required => !options.registeredTools.some(tool => tool.name === required.name
        && tool.version === required.version && tool.effect === 'READ')) ? 'tool_definition_incompatible' as const : null;
    return ExtensionCatalogItemSchema.parse({ ref: { id: manifest.id, version: manifest.version }, manifest,
      compatibility: { available: code === null, code } });
  }
  function selected(input: ExtensionSelection): ExtensionCatalogItem[] {
    const selection = ExtensionSelectionSchema.parse(input);
    if (!selection.enabledExtensions.length) return [];
    const items = selection.enabledExtensions.map(ref => {
      const name = files.find(name => (name === 'invoice-v1.json' ? 'invoice-assist' : 'subagents') === ref.id);
      if (!name) throw appError('extension_config_invalid', 'input', 'Unknown trusted extension.');
      const item = read(name);
      if (extensionRefKey(ref) !== extensionRefKey(item.ref))
        throw appError('extension_config_invalid', 'input', 'The selected extension differs from its trusted fixed identity.');
      if (!item.compatibility.available) throw appError('extension_incompatible', 'extension', 'The extension is incompatible with the current SDK or business tool.');
      return item;
    });
    return items.sort((a, b) => Number(a.ref.id === 'subagents') - Number(b.ref.id === 'subagents'));
  }
  return {
    list(): Result<readonly ExtensionCatalogItem[]> { return checked(() => files.map(read)); },
    validateSelection(selection: ExtensionSelection): Result<void> { return checked(() => { selected(selection); }); },
    freeze(input: { selection: ExtensionSelection; settingsRevision: number; activeToolNames: readonly string[];
      policy: 'p2' | 'p3' | 'fill' }): Result<FrozenExtensions> {
      return checked(() => {
        const selection = ExtensionSelectionSchema.parse(input.selection), items = selected(selection);
        const eligible = (item: ExtensionCatalogItem) => input.policy !== 'fill' && (item.ref.id === 'invoice-assist'
          ? input.policy === 'p3' && input.activeToolNames.includes('check_invoice_sources')
          : input.activeToolNames.includes('Agent'));
        return FrozenExtensionsSchema.parse({ version: 1, policyVersion: 'p13-managed-extensions-v1', settingsRevision: input.settingsRevision,
          ...(evaluationProfile ? { evaluationProfile } : {}),
          selected: selection.enabledExtensions, included: items.filter(eligible).map(item => ({ ref: item.ref, manifest: item.manifest })),
          excluded: items.filter(item => !eligible(item)).map(item => ({ ref: item.ref, code: 'tool_not_active' })) });
      });
    },
  };
}
export type ExtensionService = ReturnType<typeof createExtensionService>;
