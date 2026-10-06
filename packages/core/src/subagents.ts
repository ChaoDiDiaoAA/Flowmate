import { DelegateArgsSchema, NativeToolOutputSchema, ToolExecutionFailure, appError } from '@flowmate/contracts';
import type { AgentPort, DelegateArgs, NativeToolOutput, ToolDefinition } from '@flowmate/contracts';

/** The plugin runs the child; this definition keeps delegation inside Executor/Recorder. */
export function createSubagentTool(agent: () => AgentPort): ToolDefinition<DelegateArgs, NativeToolOutput> {
  return { name: 'Agent', version: '0.19.0-p13.1', label: 'Agent', effect: 'READ', executionMode: 'sequential',
    description: 'Delegate one foreground, read-only invoice source check to invoice-evidence-checker. Return its findings to this conversation.',
    inputSchema: DelegateArgsSchema, outputSchema: NativeToolOutputSchema,
    execute: async (args, call, product) => {
      const adapter = agent();
      if (!adapter.invokeSubagent) throw new ToolExecutionFailure(appError('subagent_origin_invalid', 'runtime', 'Managed delegation is unavailable.'));
      return adapter.invokeSubagent({ ...product, ...call }, args);
    } };
}
