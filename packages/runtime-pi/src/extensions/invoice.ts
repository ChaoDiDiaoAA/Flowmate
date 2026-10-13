import type { ExtensionFactory, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { invoiceToolSchemas } from '@flowmate/contracts';
import type { ExtensionEvaluationProfile } from '@flowmate/contracts';
import type { ExtensionScope } from './loader.ts';

/** Product business entry. Execution still delegates to the existing ToolExecutor. */
export function createInvoiceAssistExtension({ sdkTool, scope, profile }: { sdkTool: ToolDefinition; scope: ExtensionScope; profile?: ExtensionEvaluationProfile }): ExtensionFactory {
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
      if (!parsed.success) {
        scope.recordHook('tool_call', 'input_invalid', event.toolCallId);
        return;
      }
      if (!ticket.scope.allowedTools.includes(event.toolName) || !ticket.scope.allowedDocumentIds.includes(parsed.data.documentId)
        || parsed.data.sources.some(source => source.documentId !== parsed.data.documentId
          || !ticket.scope.allowedArtifactIds.includes(source.artifactId))) {
        scope.recordHook('tool_call', 'scope_invalid', event.toolCallId);
        return;
      }
      if (profile?.id === 'source-check-denial') {
        scope.recordHook('tool_call', 'eval_source_check_denied', event.toolCallId);
        return { block: true, reason: 'The frozen evaluation Hook denies source checking; authorized original evidence remains readable.' };
      }
      if (profile?.id === 'source-quote-trim') {
        const sources = parsed.data.sources.map(source => {
          const quote = source.quote?.trim();
          return quote ? { ...source, quote } : source;
        });
        if (sources.some((source, index) => source.quote !== parsed.data.sources[index].quote)) {
          Object.assign(event.input, { sources });
          scope.recordHook('tool_call', 'eval_source_quote_trimmed', event.toolCallId);
        }
      }
    });
    pi.on('tool_result', event => {
      if (event.toolName === 'check_invoice_sources') scope.observeCall('tool_result', event.toolCallId);
    });
    pi.on('tool_execution_end', event => {
      if (event.toolName === 'check_invoice_sources') scope.observeCall('tool_execution_end', event.toolCallId);
    });
    pi.on('session_shutdown', () => { scope.acknowledgeShutdown(); });
  };
}
