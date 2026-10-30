import { expect, it } from 'bun:test';
import * as contracts from '../../packages/contracts/src/index.ts';

const installationId = 'c71cd196-4a16-41f6-a2da-d11c0396f038';
const operationId = '4382d88d-870b-4d9a-954a-9396d02f5dda';

it('accepts only the original service activation identity and configuration revision', () => {
  expect(contracts.BackgroundServicePrepareRequestSchema).toBeDefined();
  expect(contracts.BackgroundServicePrepareRequestSchema.parse({})).toEqual({});
  expect(contracts.BackgroundServicePrepareRequestSchema.safeParse({ runtimeRoot: 'C:\\other' }).success).toBe(false);
  const request = { installationId, operationId, expectedSettingsRevision: 0 };
  expect(contracts.BackgroundServiceEnableRequestSchema.parse(request)).toEqual(request);
  for (const patch of [{ operationId: 'unknown' }, { expectedSettingsRevision: -1 }, { expectedSettingsRevision: Number.MAX_SAFE_INTEGER + 1 },
    { executable: 'other.exe' }, { password: 'not-a-product-input' }, { modelId: 'other-model' }])
    expect(contracts.BackgroundServiceEnableRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
  expect(contracts.BackgroundServiceActivationQuerySchema.parse({ installationId, operationId })).toEqual({ installationId, operationId });
  expect(contracts.BackgroundServiceActivationQuerySchema.safeParse(request).success).toBe(false);
  const state = { state: 'blocked', installationId, protocolVersion: null, dataVersion: null,
    activationOperationId: operationId, activationSettingsRevision: 3, error: null };
  expect(contracts.BackgroundServiceStateSchema.parse(state)).toMatchObject({ activationSettingsRevision: 3 });
  expect(contracts.BackgroundServiceStateSchema.safeParse({ ...state, activationOperationId: null }).success).toBe(false);
});

it('reports only the prepared installation without claiming SCM installation or product readiness', () => {
  const prepared = { installationId, serviceName: 'FlowmateRuntime' + installationId.replaceAll('-', ''), configurationPublished: true } as const;
  expect(contracts.BackgroundServicePreparationSchema.parse(prepared)).toEqual(prepared);
  for (const patch of [{ serviceName: 'AnotherService' }, { configurationPublished: false }, { password: 'private' }, { active: true }])
    expect(contracts.BackgroundServicePreparationSchema.safeParse({ ...prepared, ...patch }).success).toBe(false);
});

it('keeps offline activation facts unknown instead of claiming the background service stopped', () => {
  const pending = { version: 1, installationId, operationId, expectedSettingsRevision: null, accepted: true, backupId: null, credentialsPublished: null,
    enabled: false, connected: false, active: null, error: null } as const;
  expect(contracts.BackgroundServiceActivationViewSchema.parse(pending)).toEqual(pending);
  expect(contracts.BackgroundServiceActivationViewSchema.safeParse({ ...pending, active: true }).success).toBe(false);
  expect(contracts.BackgroundServiceActivationViewSchema.parse({ ...pending, enabled: true, connected: true, active: true,
    credentialsPublished: true })).toMatchObject({ active: true });
  for (const patch of [{ backupId: 'missing' }, { nativeTask: 'opaque' }, { apiKey: 'private' }])
    expect(contracts.BackgroundServiceActivationViewSchema.safeParse({ ...pending, ...patch }).success).toBe(false);
});
