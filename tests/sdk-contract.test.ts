import { describe, expect, it } from 'vitest';
import { createSdkProbe } from '../packages/runtime-pi/src/sdk-probe.ts';

describe('Pi SDK contract probe', () => {
  it('creates an offline ModelRuntime with a built-in model and no global model store', async () => {
    const probe = await createSdkProbe();

    expect(probe.error).toBeUndefined();
    expect(probe.model).toMatchObject({
      provider: 'deepseek',
      id: 'deepseek-v4-flash',
    });
    expect(probe.missingModel).toBeUndefined();
    expect(probe.networkEnabled).toBe(false);
    await probe.close();
  });
});
