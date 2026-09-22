import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type Model,
} from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export interface SdkProbe {
  runtime: ModelRuntime;
  model: Model<Api> | undefined;
  missingModel: Model<Api> | undefined;
  error: string | undefined;
  networkEnabled: false;
  close: () => Promise<void>;
}

/**
 * Creates the smallest offline ModelRuntime used by the T1 dependency probe.
 * It deliberately supplies both stores and `modelsPath: null` so that a probe
 * cannot read or write the user's global Pi catalog or credentials.
 */
export async function createSdkProbe(): Promise<SdkProbe> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });

  return {
    runtime,
    model: runtime.getModel('deepseek', 'deepseek-v4-flash'),
    missingModel: runtime.getModel('deepseek', 'flowmate-p1-intentionally-absent-model'),
    error: runtime.getError(),
    networkEnabled: false,
    // ModelRuntime 0.85.1 has no public dispose method. The probe owns no
    // socket or file store, so this is an explicit no-op rather than a fake
    // native close operation.
    close: async () => undefined,
  };
}
