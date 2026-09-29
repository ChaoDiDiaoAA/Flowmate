import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import type { AuthInteraction, AuthType, CredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ModelCatalogProvider } from '@flowmate/contracts';

export async function createPiModelCatalog() {
  const runtime = await ModelRuntime.create({ modelsPath: null, modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false, refreshOnCreate: false });
  return {
    async list(providerId?: string, refresh = false): Promise<readonly ModelCatalogProvider[]> {
      if (refresh && providerId) await runtime.refresh({ providers: [providerId], allowNetwork: true, force: true });
      return runtime.getProviders().filter((provider) => !providerId || provider.id === providerId).map((provider) => ({
        id: provider.id,
        name: provider.name,
        authMethods: [provider.auth.apiKey?.login ? 'api_key' : provider.auth.apiKey ? 'ambient' : null,
          provider.auth.oauth ? 'oauth' : null].filter((method): method is 'api_key' | 'oauth' | 'ambient' => method !== null),
        models: runtime.getModels(provider.id).map((model) => ({ id: model.id, name: model.name, api: model.api,
          contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning })),
      }));
    },
  };
}

export async function loginPiProvider(providerId: string, type: AuthType, credentials: CredentialStore,
  interaction: AuthInteraction): Promise<void> {
  const runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, signal: interaction.signal });
  if (!runtime.getProvider(providerId)) throw new Error('provider_not_found');
  await runtime.login(providerId, type, interaction);
}

export async function logoutPiProvider(providerId: string, credentials: CredentialStore): Promise<void> {
  const runtime = await ModelRuntime.create({ credentials, modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  if (!runtime.getProvider(providerId)) throw new Error('provider_not_found');
  await runtime.logout(providerId);
}
