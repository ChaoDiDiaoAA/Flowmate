import { LangfuseClient } from '@langfuse/client';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';

export type LangfuseRuntime = { client: LangfuseClient; shutdown: () => Promise<void> };

export async function createLangfuseRuntime(): Promise<LangfuseRuntime> {
  for (const name of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL'] as const) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.start();
  const client = new LangfuseClient();
  return {
    client,
    shutdown: async () => {
      await client.flush();
      await client.shutdown();
      await sdk.shutdown();
    },
  };
}

export async function doctor(client: LangfuseClient): Promise<{ ok: true; baseUrl: string; datasetCount: number }> {
  const response = await client.api.datasets.list({ limit: 1 });
  const data = response.data;
  return { ok: true, baseUrl: process.env.LANGFUSE_BASE_URL!, datasetCount: data.length };
}
