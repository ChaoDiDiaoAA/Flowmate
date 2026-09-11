import {
  DefaultResourceLoader,
  type InlineExtension,
  type ResourceLoader,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type P0ResourceOptions = {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  systemPrompt?: string;
  extensionPaths?: string[];
  extensionFactories?: InlineExtension[];
};

/**
 * Construct the only resource loader shape allowed for a P0 session. Global
 * skills, prompts, themes, context files and extensions are disabled; callers
 * must supply every approved extension explicitly.
 */
export function createP0ResourceLoader(options: P0ResourceOptions): ResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager: options.settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(options.extensionPaths && options.extensionPaths.length > 0 ? { additionalExtensionPaths: [...options.extensionPaths] } : {}),
    ...(options.extensionFactories && options.extensionFactories.length > 0 ? { extensionFactories: [...options.extensionFactories] } : {}),
    ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
  });
}

export async function reloadP0Resources(loader: ResourceLoader): Promise<ResourceLoader> {
  await loader.reload();
  return loader;
}
