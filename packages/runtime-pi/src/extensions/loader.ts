import { randomUUID } from 'node:crypto';
import { DefaultResourceLoader, SettingsManager, VERSION, type ExtensionAPI,
  type LoadExtensionsResult, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { appError, NativeExtensionCommandReceiptSchema, ExtensionAssemblyEvidenceSchema, EXTENSION_HOOKS, FrozenExtensionsSchema, ExtensionInstanceViewSchema, extensionRefKey } from '@flowmate/contracts';
import type { AppError, ExtensionAssemblyEvidence, ExtensionHookEvent, ExtensionInstanceView, FrozenExtensions, NativeExtensionCommandReceipt,
  RequestContextBinding, Result, RunScope } from '@flowmate/contracts';
import { createInvoiceAssistExtension } from './invoice.ts';
import { createSubagentExtension } from './subagents.ts';

export type CallTicket = { instanceId: string; nativeSessionId: string; runId: number; sessionId: number;
  nativeToolCallId: string; requestBinding: RequestContextBinding; scope: RunScope };
type CommandTicket = { operationId: string; instanceId: string; nativeSessionId: string };
export type ExtensionScope = ReturnType<typeof createScope>;
export type LoadedExtensionSet = { result: LoadExtensionsResult | null; scopes: ExtensionScope[]; error: AppError | null };
export function extensionAssembly(loaded: LoadedExtensionSet): ExtensionAssemblyEvidence {
  return ExtensionAssemblyEvidenceSchema.parse({ version: 1, sdkVersion: '0.85.1', instances: loaded.scopes.flatMap(scope => scope.evidence().instances) });
}
function createScope(input: { selected: FrozenExtensions['included'][number]; nativeSessionId: string;
  assertCallOwner: (event: { toolName: string; toolCallId: string }, instanceId: string) => Result<CallTicket>;
  onCriticalFailure: (error: AppError, instanceId: string) => void }) {
  const selected = input.selected, now = () => new Date().toISOString();
  const view: Omit<{ -readonly [K in keyof ExtensionInstanceView]: ExtensionInstanceView[K] }, 'cleanup'> & {
    cleanup: { -readonly [K in keyof ExtensionInstanceView['cleanup']]: ExtensionInstanceView['cleanup'][K] }
  } = { instanceId: randomUUID(), ref: selected.ref, nativeSessionId: input.nativeSessionId,
    state: 'loading', admission: 'closed', startedAt: now(), activatedAt: null, disposedAt: null, lastError: null,
    registeredTools: [], registeredCommands: [], hookEvents: [], diagnostics: [],
    cleanup: { shutdownRequired: false, shutdownAcknowledged: false, sdkSessionCreated: false, sdkDisposed: false, ownedCallbacksSettled: false } };
  let pending = 0, factorySettled = false, startAcknowledged = false;
  let command: { ticket: CommandTicket; receipt?: NativeExtensionCommandReceipt } | null = null;
  let inputCommand: { arguments: string; owner: { inputId: number; runId: number; sessionId: number }; acknowledged: boolean } | null = null;
  const tickets = new Map<string, CallTicket>(), phaseErrors = new Map<ExtensionHookEvent, AppError>();
  const settled = () => { view.cleanup.ownedCallbacksSettled = factorySettled && pending === 0 && command === null && inputCommand === null; };
  const scope = {
    view,
    factorySettled() { factorySettled = true; settled(); },
    recordHook(event: ExtensionHookEvent, code: string, nativeToolCallId?: string) {
      view.diagnostics = [...view.diagnostics.slice(-19), { event, code, at: now(), ...(nativeToolCallId ? { nativeToolCallId } : {}) }];
    },
    assertCallOwner(event: { toolName: string; toolCallId: string }) {
      if (view.state !== 'active' || view.admission !== 'open') throw appError('extension_hook_failed', 'extension', 'Extension execution admission is closed.');
      const checked = input.assertCallOwner(event, view.instanceId); if (!checked.ok) throw checked.error;
      const prior = tickets.get(event.toolCallId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(checked.data)) throw appError('extension_hook_failed', 'extension', 'Extension call ownership changed.');
      tickets.set(event.toolCallId, checked.data); return checked.data;
    },
    observeCall(event: 'tool_result' | 'tool_execution_end', callId: string) {
      const ticket = tickets.get(callId);
      scope.recordHook(event, ticket ? view.admission === 'open' ? 'observed' : 'late_observation' : 'unbound_observation', callId);
    },
    acknowledgeStart() { if (view.state !== 'loading') throw new Error('Unexpected startup.'); startAcknowledged = true; },
    acknowledgeShutdown() { view.admission = 'closed'; command = null; tickets.clear(); view.cleanup.shutdownAcknowledged = true; },
    getCommandTicket() {
      if (!command || view.state !== 'active' || view.admission !== 'open') throw new Error('Command has no active owner.');
      return command.ticket;
    },
    beginInputCommand(argumentsText: string, owner: { inputId: number; runId: number; sessionId: number }) {
      if (command || inputCommand || view.state !== 'active' || view.admission !== 'open') throw new Error('Input command has no open owner.');
      inputCommand = { arguments: argumentsText, owner: { ...owner }, acknowledged: false }; settled();
    },
    acknowledgeInputCommand(argumentsText: string, nativeSessionId: string) {
      if (!inputCommand || inputCommand.acknowledged || argumentsText !== inputCommand.arguments || nativeSessionId !== view.nativeSessionId
        || view.state !== 'active' || view.admission !== 'open') throw new Error('Input command binding changed.');
      inputCommand.acknowledged = true;
    },
    finishInputCommand() { const receipt = inputCommand?.acknowledged ? inputCommand.owner : null; inputCommand = null; settled(); return receipt; },
    writeCommandReceipt(ticket: CommandTicket) {
      if (!command || command.ticket !== ticket || command.receipt) throw new Error('Command receipt is stale or duplicated.');
      command.receipt = NativeExtensionCommandReceiptSchema.parse({ nativeSessionId: view.nativeSessionId, instanceId: view.instanceId, name: 'invoice-assist', ref: view.ref,
        registeredTools: [...view.registeredTools], hookEvents: [...view.hookEvents], completedAt: now() });
    },
    beginCommand() { command = { ticket: { operationId: randomUUID(), instanceId: view.instanceId, nativeSessionId: view.nativeSessionId } }; settled(); },
    finishCommand() { const receipt = command?.receipt; command = null; settled(); return receipt; },
    clearPhaseError(event: ExtensionHookEvent) { phaseErrors.delete(event); },
    phaseError(event: ExtensionHookEvent) { return phaseErrors.get(event); },
    fail(error: AppError) { view.admission = 'closed'; view.lastError = error; if (view.state === 'loading') view.state = 'load_failed'; },
    async dispatch(event: ExtensionHookEvent, handler: (...args: any[]) => unknown, args: unknown[]) {
      pending++; settled();
      try { return await handler(...args); }
      catch {
        scope.recordHook(event, 'handler_failed', (args[0] as { toolCallId?: string })?.toolCallId);
        if (EXTENSION_HOOKS.find(hook => hook.event === event)!.policy === 'observer') return undefined;
        const error = appError('extension_hook_failed', 'extension', `Required Extension Hook failed: ${event}.`);
        phaseErrors.set(event, error); scope.fail(error); input.onCriticalFailure(error, view.instanceId); throw error;
      } finally { pending--; settled(); }
    },
    activate(): Result<void> {
      if (!startAcknowledged || phaseErrors.has('session_start') || view.state !== 'loading')
        return { ok: false, error: phaseErrors.get('session_start') ?? appError('extension_load_failed', 'extension', 'Extension startup was not acknowledged.', true) };
      view.state = 'active'; view.admission = 'open'; view.activatedAt = now(); return { ok: true, data: undefined };
    },
    evidence(): ExtensionAssemblyEvidence {
      if (view.state !== 'active' || view.admission !== 'open' || !view.activatedAt) throw new Error('Extension has no active assembly proof.');
      return ExtensionAssemblyEvidenceSchema.parse({ version: 1, sdkVersion: '0.85.1', instances: [{ instanceId: view.instanceId, ref: view.ref, nativeSessionId: view.nativeSessionId,
        activatedAt: view.activatedAt, registeredTools: [...view.registeredTools], registeredCommands: [...view.registeredCommands], hookEvents: [...view.hookEvents] }] });
    },
    snapshot() { return ExtensionInstanceViewSchema.parse(structuredClone(view)); },
  };
  return scope;
}

/** Public SDK loader, with discovery disabled and a closed registration ledger. */
export async function loadControlledExtensions(input: { frozen: FrozenExtensions; nativeSessionId: string;
  sdkToolFor: (name: string, nativeParameters?: ToolDefinition['parameters']) => ToolDefinition;
  subagent: Omit<Parameters<typeof createSubagentExtension>[0], 'scope' | 'sdkTool'>;
  cwd: string; agentDir: string; signal: AbortSignal; onCreated: (loaded: LoadedExtensionSet) => void;
  assertCallOwner: Parameters<typeof createScope>[0]['assertCallOwner']; onCriticalFailure: (error: AppError, instanceId: string) => void }): Promise<LoadedExtensionSet> {
  const frozen = FrozenExtensionsSchema.parse(input.frozen), scopes = frozen.included.map(selected => createScope({ ...input, selected }));
  const loaded: LoadedExtensionSet = { result: null, scopes, error: null }; input.onCreated(loaded);
  let registrationFailure: AppError | null = null;
  try {
    if (VERSION !== '0.85.1' || frozen.included.length < 1)
      throw appError('extension_incompatible', 'extension', 'Installed SDK or source tool is incompatible.');
    const factories = frozen.included.map((selected, index) => {
      const scope = scopes[index]!, manifest = selected.manifest;
      const toolName = manifest.tools[0]!.name;
      let sdkTool: ToolDefinition;
      const factory = manifest.id === 'invoice-assist' ? createInvoiceAssistExtension({ sdkTool: sdkTool = input.sdkToolFor(toolName), scope })
        : createSubagentExtension({ ...input.subagent, sdkTool: parameters => sdkTool = input.sdkToolFor(toolName, parameters), scope });
      let registrationOpen = true;
      const conflict = () => {
        const error = registrationFailure ??= appError('extension_registration_conflict', 'extension', 'Extension registration does not match the controlled manifest.');
        scope.fail(error); input.onCriticalFailure(error, scope.view.instanceId); throw error;
      };
      return { name: extensionRefKey(selected.ref), factory: async (pi: ExtensionAPI) => {
        const guarded = new Proxy(pi, { get(target, property) {
          if (property === 'registerTool') return (tool: ToolDefinition) => {
            // The plugin's raw tool is captured inside its factory; only the product wrapper reaches this registry.
            if (!registrationOpen || !sdkTool || tool.name !== sdkTool.name || manifest.id === 'invoice-assist' && tool !== sdkTool
              || scopes.some(owner => owner.view.registeredTools.includes(tool.name))
              || !manifest.tools.some(item => item.name === tool.name)
              || JSON.stringify(tool.parameters) !== JSON.stringify(sdkTool.parameters)) conflict();
            Reflect.apply(target.registerTool, target, [tool]); scope.view.registeredTools = [...scope.view.registeredTools, tool.name];
          };
          if (property === 'registerCommand') return (name: string, options: unknown) => {
            if (!registrationOpen || !(manifest.commands as readonly string[]).includes(name)
              || scopes.some(owner => owner.view.registeredCommands.includes(name))) conflict();
            Reflect.apply(target.registerCommand, target, [name, options]); scope.view.registeredCommands = [...scope.view.registeredCommands, name];
          };
          if (property === 'on') return (event: ExtensionHookEvent, handler: (...args: any[]) => unknown) => {
            if (!registrationOpen || !manifest.hooks.some(hook => hook.event === event) || scope.view.hookEvents.includes(event) || typeof handler !== 'function') conflict();
            Reflect.apply(target.on, target, [event, (...args: unknown[]) => scope.dispatch(event, handler, args)]);
            scope.view.hookEvents = [...scope.view.hookEvents, event];
          };
          return () => conflict();
        } }) as ExtensionAPI;
        try { await factory(guarded); } finally { registrationOpen = false; scope.factorySettled(); }
      } };
    });
    const loader = new DefaultResourceLoader({ cwd: input.cwd, agentDir: input.agentDir,
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [] }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [], additionalSkillPaths: [], additionalPromptTemplatePaths: [], additionalThemePaths: [],
      systemPrompt: 'Controlled Flowmate extension assembly.', appendSystemPrompt: [],
      extensionFactories: factories,
    });
    await loader.reload(); loaded.result = loader.getExtensions();
    if (registrationFailure) throw registrationFailure;
    if (loaded.result.errors.length || loaded.result.extensions.length !== scopes.length
      || frozen.included.some(({ manifest }, index) => {
        const scope = scopes[index]!;
        return JSON.stringify(scope.view.registeredTools) !== JSON.stringify(manifest.tools.map(item => item.name))
          || JSON.stringify(scope.view.registeredCommands) !== JSON.stringify(manifest.commands)
          || JSON.stringify(scope.view.hookEvents) !== JSON.stringify(manifest.hooks.map(item => item.event));
      }))
      throw appError('extension_load_failed', 'extension', 'Controlled Extension registration is incomplete.', true);
    if (input.signal.aborted) throw appError('agent_cancelled', 'runtime', 'Extension loading was cancelled.');
  } catch (error) {
    loaded.error = error && typeof error === 'object' && 'code' in error ? error as AppError
      : appError('extension_load_failed', 'extension', 'Controlled Extension could not be loaded.', true);
    for (const scope of scopes) scope.fail(loaded.error);
  } finally { for (const scope of scopes) scope.factorySettled(); }
  return loaded;
}
