import { z } from 'zod';
import { validateToolArguments, type TSchema } from '@earendil-works/pi-ai';
import {
  createReadToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
  createEditToolDefinition, createWriteToolDefinition, createBashToolDefinition, createPowerShellToolDefinition,
  getShellConfig, getPowerShellConfig, getToolPath,
} from '@earendil-works/pi-coding-agent';
import {
  appError, NATIVE_TOOL_NAMES, NativeToolOutputSchema, ToolExecutionFailure,
  type NativeToolAvailability, type NativeToolOutput, type ProductToolContext, type Result, type ToolDefinition,
} from '@flowmate/contracts';

const parameters = new WeakMap<ToolDefinition<any, any>, TSchema>();
export type NativeToolsOptions = { getWorkingDirectory(ctx: ProductToolContext): Result<string> };
export function getNativeToolParameters(definition: ToolDefinition<any, any>): TSchema | undefined { return parameters.get(definition); }

export function createNativeTools(options: NativeToolsOptions): {
  definitions: readonly ToolDefinition<unknown, NativeToolOutput>[]; availability: readonly NativeToolAvailability[];
} {
  const factories = { read: createReadToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition,
    ls: createLsToolDefinition, edit: createEditToolDefinition, write: createWriteToolDefinition,
    bash: createBashToolDefinition, powershell: createPowerShellToolDefinition };
  const availability: NativeToolAvailability[] = NATIVE_TOOL_NAMES.map(name => {
    try {
      if (name === 'bash') getShellConfig();
      if (name === 'powershell') getPowerShellConfig();
      if ((name === 'grep' || name === 'find') && !getToolPath(name === 'grep' ? 'rg' : 'fd'))
        return { name, available: false, reason: name === 'grep' ? 'Pi requires ripgrep (rg), which is unavailable.' : 'Pi requires fd, which is unavailable.' };
      return { name, available: true, reason: null };
    } catch { return { name, available: false, reason: name === 'powershell' && process.platform !== 'win32'
      ? 'Pi PowerShell is only available on Windows.' : 'Pi could not resolve the required shell executable.' }; }
  });
  const definitions = NATIVE_TOOL_NAMES.map((name, index) => {
    const schemaTool = factories[name](process.cwd());
    const definition: ToolDefinition<unknown, NativeToolOutput> = {
      name, version: 'pi-0.85.1', label: schemaTool.label, description: schemaTool.description,
      inputSchema: z.unknown().transform((raw, context) => {
        try {
          const input = structuredClone(raw);
          const prepared = schemaTool.prepareArguments ? schemaTool.prepareArguments(input as never) : input;
          return validateToolArguments(schemaTool, { type: 'toolCall', id: 'schema-check', name, arguments: prepared as never });
        } catch { context.addIssue({ code: 'custom', message: 'Native tool arguments do not match the SDK schema.' }); return z.NEVER; }
      }),
      outputSchema: NativeToolOutputSchema, effect: index < 4 ? 'READ' : 'LOCAL_WRITE',
      executionMode: index < 4 ? 'parallel' : 'sequential',
      async execute(input, call, ctx) {
        const working = options.getWorkingDirectory(ctx);
        if (!working.ok) throw new ToolExecutionFailure(working.error);
        const native = factories[name](working.data);
        let partial: NativeToolOutput | undefined;
        try {
          const result = await native.execute(call.nativeToolCallId, input as never, call.signal,
            update => { partial = output(update); }, undefined as never);
          return output(result);
        } catch (error) {
          if (error instanceof ToolExecutionFailure) throw error;
          const message = error instanceof Error ? error.message : 'The native tool could not complete.';
          const timeout = (input as { timeout?: number }).timeout;
          const code = call.signal.aborted ? 'tool_cancelled'
            : (name === 'bash' || name === 'powershell') && timeout !== undefined
              && message.endsWith(`Command timed out after ${timeout} seconds`) ? 'tool_timeout' : 'tool_execution_failed';
          throw new ToolExecutionFailure(appError(code, 'tool', 'The native tool could not complete the requested operation.'),
            { content: [{ type: 'text', text: message }], ...(partial?.details === undefined ? {} : { details: partial.details }) });
        }
      },
    };
    parameters.set(definition, schemaTool.parameters);
    return definition;
  });
  return { definitions: Object.freeze(definitions), availability: Object.freeze(availability) };
}

function output(result: { content: NativeToolOutput['content']; details?: unknown }): NativeToolOutput {
  // SDK shell updates include optional undefined properties; omit them exactly as JSON storage would.
  const details = result.details && typeof result.details === 'object' && !Array.isArray(result.details)
    ? Object.fromEntries(Object.entries(result.details).filter(([, value]) => value !== undefined)) : result.details;
  return { content: result.content, ...(details === undefined ? {} : { details }) };
}
