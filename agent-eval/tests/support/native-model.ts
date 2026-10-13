import type { AgentModelCapabilities } from '../../src/configuration.ts';

// Local fake Provider capacities; production resolves these values from the Pi SDK catalog.
export const syntheticNativeModel: AgentModelCapabilities = { contextWindow: 131072, maxTokens: 32768, reasoning: false,
    source: 'pi-sdk-model-catalog', providers: ['synthetic'] };
