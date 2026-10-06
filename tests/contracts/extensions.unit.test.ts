import { describe, expect, it } from 'bun:test';
import type { ZodTypeAny } from 'zod';
import * as contracts from '../../packages/contracts/src/index.ts';

const schema = (name: string): ZodTypeAny | undefined => Reflect.get(contracts, name);
const hash = 'a'.repeat(64), at = '2026-10-06T08:00:00.000Z';
const instanceId = '5c080336-167f-437b-9959-0888e7708045';
const otherInstance = '24df64c4-8bba-4327-bd38-3546e7cae10c';
const ref = { id: 'invoice-assist', version: 'v1', manifestHash: hash };
const hooks = [
  { event: 'session_start', policy: 'critical' }, { event: 'tool_call', policy: 'critical' },
  { event: 'tool_result', policy: 'observer' }, { event: 'tool_execution_end', policy: 'observer' },
  { event: 'session_shutdown', policy: 'critical' },
] as const;
const manifest = { schemaVersion: 1, kind: 'extension', id: 'invoice-assist', version: 'v1', sdkVersion: '0.85.1',
  entryId: 'invoice-assist-v1', tools: [{ name: 'check_invoice_sources', version: '1' }], commands: ['invoice-assist'], hooks } as const;
const selection = { enabledExtensions: [ref] };
const frozen = { version: 1, policyVersion: 'p12-managed-extensions-v1', settingsRevision: 2,
  selected: [ref], included: [{ ref, manifest }], excluded: [] };
const instance = { instanceId, ref, nativeSessionId: 'native-1', state: 'active', admission: 'open', startedAt: at,
  activatedAt: at, disposedAt: null, lastError: null, registeredTools: ['check_invoice_sources'],
  registeredCommands: ['invoice-assist'], hookEvents: hooks.map(hook => hook.event), diagnostics: [],
  cleanup: { shutdownRequired: true, shutdownAcknowledged: false, sdkSessionCreated: true,
    sdkDisposed: false, ownedCallbacksSettled: true } };
const assembly = { version: 1, sdkVersion: '0.85.1', instances: [{ instanceId, ref, nativeSessionId: 'native-1',
  activatedAt: at, registeredTools: ['check_invoice_sources'], registeredCommands: ['invoice-assist'],
  hookEvents: hooks.map(hook => hook.event) }] };

describe('P12 controlled extension contracts', () => {
  it('[F12-02/07] refuses executable paths, duplicate or unsupported declarations', () => {
    expect(schema('ExtensionRefSchema')?.safeParse(ref).success).toBe(true);
    for (const change of [{ id: '..' }, { version: 'CON' }, { manifestHash: 'A'.repeat(64) }, { entry: 'C:/secret.js' }])
      expect(schema('ExtensionRefSchema')?.safeParse({ ...ref, ...change }).success).toBe(false);
    expect(schema('ExtensionManifestSchema')?.safeParse(manifest).success).toBe(true);
    for (const change of [{ entryId: '../module.ts' }, { sdkVersion: '1.0.2' }, { commands: ['compact'] },
      { tools: [...manifest.tools, ...manifest.tools] }, { hooks: hooks.slice(1) },
      { hooks: [hooks[0], ...hooks.slice(0, 4)] }, { hooks: hooks.map(hook => ({ ...hook, policy: 'observer' })) },
      { exec: 'arbitrary' }])
      expect(schema('ExtensionManifestSchema')?.safeParse({ ...manifest, ...change }).success).toBe(false);
    expect(schema('ExtensionSelectionSchema')?.safeParse(selection).success).toBe(true);
    expect(schema('ExtensionSelectionSchema')?.safeParse({ enabledExtensions: [ref, ref] }).success).toBe(false);
  });

  it('[F12-04/23] preserves an exact selected partition and historical proof ownership', () => {
    expect(schema('FrozenExtensionsSchema')?.safeParse(frozen).success).toBe(true);
    for (const change of [{ included: [] }, { excluded: [{ ref, code: 'tool_not_active' }] },
      { included: [{ ref: { ...ref, manifestHash: 'b'.repeat(64) }, manifest }] },
      { included: [{ ref, manifest: { ...manifest, id: 'other' } }] }])
      expect(schema('FrozenExtensionsSchema')?.safeParse({ ...frozen, ...change }).success).toBe(false);
    const view = { sessionId: 1, runId: 2, frozen, assembly };
    expect(schema('RunExtensionViewSchema')?.safeParse(view).success).toBe(true);
    expect(schema('RunExtensionViewSchema')?.safeParse({ sessionId: 1, runId: 2, frozen: null, assembly: null }).success).toBe(true);
    expect(schema('RunExtensionViewSchema')?.safeParse({ ...view, frozen: null }).success).toBe(false);
    expect(schema('RunExtensionViewSchema')?.safeParse({ ...view, assembly: { ...assembly,
      instances: [{ ...assembly.instances[0], ref: { ...ref, manifestHash: 'b'.repeat(64) } }] } }).success).toBe(false);
    expect(schema('RunExtensionViewSchema')?.safeParse({ ...view, assembly: { ...assembly, instances: [] } }).success).toBe(false);
    const old = { revision: 3, selection: { prompt: null, enabledSkills: [] } };
    expect(schema('AssemblySelectionSnapshotSchema')?.parse(old).extensions).toEqual({ enabledExtensions: [] });
    expect(contracts.ResourceSelectionResultSchema.safeParse({ ...old, extensions: selection }).success).toBe(false);
  });

  it('[F12-14/16] never calls unfinished resources disposed or fabricates shutdown evidence', () => {
    expect(schema('ExtensionInstanceViewSchema')?.safeParse(instance).success).toBe(true);
    const disposed = { ...instance, state: 'disposed', admission: 'closed', disposedAt: at };
    expect(schema('ExtensionInstanceViewSchema')?.safeParse(disposed).success).toBe(false);
    expect(schema('ExtensionInstanceViewSchema')?.safeParse({ ...disposed,
      cleanup: { ...instance.cleanup, shutdownAcknowledged: true, sdkDisposed: true } }).success).toBe(true);
    expect(schema('ExtensionInstanceViewSchema')?.safeParse({ ...disposed,
      cleanup: { ...instance.cleanup, shutdownAcknowledged: true, sdkDisposed: true, ownedCallbacksSettled: false } }).success).toBe(false);
    const partial = { ...disposed, activatedAt: null, registeredTools: [], registeredCommands: [], hookEvents: [],
      cleanup: { shutdownRequired: false, shutdownAcknowledged: false, sdkSessionCreated: false,
        sdkDisposed: false, ownedCallbacksSettled: true } };
    expect(schema('ExtensionInstanceViewSchema')?.safeParse(partial).success).toBe(true);
    expect(schema('ExtensionInstanceViewSchema')?.safeParse({ ...partial, cleanup: { ...partial.cleanup, sdkDisposed: true } }).success).toBe(false);
    expect(schema('ExtensionInstanceViewSchema')?.safeParse({ ...instance, state: 'loading' }).success).toBe(false);
  });

  it('[F12-24] rejects old-instance receipts, cross-Session results and unconfirmed config saves', () => {
    const matches = Reflect.get(contracts, 'matchesExtensionResponse');
    const request = { type: 'execute_extension_command', input: { sessionId: 1, expectedInstanceId: instanceId,
      name: 'invoice-assist', arguments: '' } };
    const receipt = { sessionId: 1, instanceId, name: 'invoice-assist', ref,
      registeredTools: ['check_invoice_sources'], hookEvents: hooks.map(hook => hook.event), completedAt: at };
    expect(matches?.(request, contracts.ok(receipt))).toBe(true);
    expect(matches?.(request, contracts.ok({ ...receipt, instanceId: otherInstance }))).toBe(false);
    expect(matches?.(request, contracts.ok({ ...receipt, sessionId: 2 }))).toBe(false);
    expect(matches?.({ ...request, input: { ...request.input, arguments: 'read document 7' } }, contracts.ok(receipt))).toBe(false);
    const save = { type: 'update_extension_selection', input: { expectedRevision: 2, selection } };
    expect(matches?.(save, contracts.ok({ revision: 3, selection }))).toBe(true);
    expect(matches?.(save, contracts.ok({ revision: 2, selection }))).toBe(false);
    expect(matches?.(save, contracts.ok({ revision: 3, selection: { enabledExtensions: [] } }))).toBe(false);
    expect(matches?.({ type: 'query_run_extensions', input: { sessionId: 1, runId: 2 } },
      contracts.ok({ sessionId: 2, runId: 2, frozen: null, assembly: null }))).toBe(false);
  });

  it('[F12-02] canonicalizes object keys while retaining the declared Hook order', () => {
    const canonical = Reflect.get(contracts, 'canonicalExtensionManifest');
    const expected = '{"schemaVersion":1,"kind":"extension","id":"invoice-assist","version":"v1","sdkVersion":"0.85.1",'
      + '"entryId":"invoice-assist-v1","tools":[{"name":"check_invoice_sources","version":"1"}],"commands":["invoice-assist"],'
      + '"hooks":[{"event":"session_start","policy":"critical"},{"event":"tool_call","policy":"critical"},'
      + '{"event":"tool_result","policy":"observer"},{"event":"tool_execution_end","policy":"observer"},'
      + '{"event":"session_shutdown","policy":"critical"}]}';
    expect(canonical?.({ ...manifest, tools: [{ version: '1', name: 'check_invoice_sources' }] })).toBe(expected);
  });
});
