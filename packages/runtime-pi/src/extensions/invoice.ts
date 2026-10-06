import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { invoiceToolSchemas } from '@flowmate/contracts';
import type { ExtensionScope } from './loader.ts';

/** Product business entry. Execution still delegates to the existing ToolExecutor. */
export function createInvoiceAssistExtension({ sdkTool, scope }: { sdkTool: ToolDefinition; scope: ExtensionScope }): ExtensionFactory {
  return pi => {
    pi.registerTool(sdkTool);
    pi.registerCommand('invoice-assist', { description: 'Inspect the current invoice assistance extension', handler: async (args, ctx) => {
      const ticket = scope.getCommandTicket();
      if (args !== '' || ctx.sessionManager.getSessionId() !== ticket.nativeSessionId || ctx.mode !== 'print' || !ctx.isIdle())
        throw new Error('Invalid command context.');
      scope.writeCommandReceipt(ticket);
    } });
    pi.on('session_start', (_event, ctx) => {
      if (ctx.mode !== 'print' || ctx.sessionManager.getSessionId() !== scope.view.nativeSessionId)
        throw new Error('Invalid extension owner.');
      scope.acknowledgeStart();
    });
    pi.on('tool_call', event => {
      if (event.toolName !== 'check_invoice_sources') return;
      const ticket = scope.assertCallOwner(event);
      // Normal invalid arguments remain a recorded tool failure at the shared final boundary.
      const parsed = invoiceToolSchemas.check_invoice_sources.input.safeParse(event.input);
      if (!parsed.success)
        scope.recordHook('tool_call', 'input_invalid', event.toolCallId);
      else if (!ticket.scope.allowedTools.includes(event.toolName) || !ticket.scope.allowedDocumentIds.includes(parsed.data.documentId)
        || parsed.data.sources.some(source => source.documentId !== parsed.data.documentId
          || !ticket.scope.allowedArtifactIds.includes(source.artifactId)))
        scope.recordHook('tool_call', 'scope_invalid', event.toolCallId);
    });
    pi.on('tool_result', event => {
      if (event.toolName === 'check_invoice_sources') scope.observeCall('tool_result', event.toolCallId);
    });
    pi.on('tool_execution_end', event => {
      if (event.toolName === 'check_invoice_sources') scope.observeCall('tool_execution_end', event.toolCallId);
    });
    pi.on('session_shutdown', () => scope.acknowledgeShutdown());
  };
}
