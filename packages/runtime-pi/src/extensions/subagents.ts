import { createManagedSubagentExtension } from '@tintinweb/pi-subagents/dist/index.js';
import type { ManagedChildControl } from '@tintinweb/pi-subagents/dist/agent-runner.js';
import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { appError } from '@flowmate/contracts';
import type { ExtensionScope, CallTicket } from './loader.ts';

export type DelegateExecution = { rawTool: ToolDefinition; ticket: CallTicket;
  arguments: unknown; nativeArguments: Parameters<ToolDefinition['execute']> };

/** Captures the plugin tool without exposing its manager or alternate startup entry. */
export function createSubagentExtension(input: { sdkTool: (parameters: ToolDefinition['parameters']) => ToolDefinition; scope: ExtensionScope;
  controlForCall: (nativeToolCallId: string) => ManagedChildControl;
  withNativeCall: (call: DelegateExecution, invokeProduct: () => ReturnType<ToolDefinition['execute']>) => ReturnType<ToolDefinition['execute']>;
}): ExtensionFactory {
  return async pi => {
    let rawTool: ToolDefinition | undefined;
    let shutdown: ((...args: any[]) => unknown) | undefined;
    const reject = () => { throw appError('extension_registration_conflict', 'extension', 'Managed plugin registered an unexpected entry.'); };
    await createManagedSubagentExtension({ controlForCall: input.controlForCall })(new Proxy(pi, { get(_target, key) {
      if (key === 'registerTool') return (tool: ToolDefinition) => {
        if (rawTool || tool.name !== 'Agent' || Reflect.get(tool.parameters, 'additionalProperties') !== false
          || Object.keys(Reflect.get(tool.parameters, 'properties') ?? {}).sort().join(',') !== 'description,prompt,run_in_background,subagent_type') reject();
        rawTool = tool;
      };
      if (key === 'on') return (event: string, handler: (...args: any[]) => unknown) => {
        if (event !== 'session_shutdown' || shutdown || typeof handler !== 'function') reject();
        shutdown = handler;
      };
      return reject;
    } }));
    if (!rawTool || !shutdown) reject();
    const tool = rawTool!;
    const sdkTool = input.sdkTool(tool.parameters);
    pi.registerTool({ ...sdkTool, execute: (...args) => {
      const [nativeToolCallId, parameters, , , ctx] = args;
      const ticket = input.scope.assertCallOwner({ toolName: 'Agent', toolCallId: nativeToolCallId });
      if (ctx.sessionManager.getSessionId() !== ticket.nativeSessionId || ctx.mode !== 'print') reject();
      return input.withNativeCall({ rawTool: tool, ticket, arguments: parameters, nativeArguments: args },
        () => sdkTool.execute(...args));
    } });
    pi.registerCommand('subagent', { description: 'Delegate a task to a registered subagent', handler: async (args, ctx) => {
      if (ctx.mode !== 'print') reject();
      input.scope.acknowledgeInputCommand(args, ctx.sessionManager.getSessionId());
    } });
    pi.on('session_start', (_event, ctx) => {
      if (ctx.mode !== 'print' || ctx.sessionManager.getSessionId() !== input.scope.view.nativeSessionId) reject();
      input.scope.acknowledgeStart();
    });
    pi.on('tool_call', event => { if (event.toolName === 'Agent') input.scope.assertCallOwner(event); });
    pi.on('tool_result', event => { if (event.toolName === 'Agent') input.scope.observeCall('tool_result', event.toolCallId); });
    pi.on('tool_execution_end', event => { if (event.toolName === 'Agent') input.scope.observeCall('tool_execution_end', event.toolCallId); });
    pi.on('session_shutdown', async (...args) => { await shutdown!(...args); input.scope.acknowledgeShutdown(); });
  };
}
