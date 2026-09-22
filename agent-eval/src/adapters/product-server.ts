import { createInterface } from 'node:readline';
import { ok } from '@flowmate/contracts';
import type { Application } from '@flowmate/contracts';
import { createApplication } from '../../../apps/composition.ts';
import { PiProviderAdapter } from '@flowmate/runtime-pi';
import { createFixtureDependencies } from './pi_fixture.ts';
import { serve, type ResponseFrame } from './flowmate.ts';

async function* stdinLines(): AsyncIterable<string> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  for await (const line of lines) if (line.trim()) yield line;
}

function write(frame: ResponseFrame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

await serve(stdinLines(), write, {
  createApp: async (start) => {
    if (start.mode === 'live') return createApplication({ paths: start.paths });
    const fixture = await createFixtureDependencies(start.faultProfile);
    await fixture.credentials.modify(start.productConfig.modelRef.provider, async () => ({ type: 'api_key', key: 'fixture-synthetic-key' }));
    const application = await createApplication({ paths: start.paths, provider: new PiProviderAdapter(fixture) });
    return application.ok ? ok(application.data as Application) : application;
  },
});
