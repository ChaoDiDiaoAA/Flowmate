import { appError, fail, ok, parseDesktopBridgeResult, type BrowserTarget, type DesktopBridgeRequest,
  type DesktopBridgeResult, type ProductToolContext } from '@flowmate/contracts';

export function createBrowserBridge(request: (input: DesktopBridgeRequest, signal: AbortSignal) => Promise<DesktopBridgeResult>) {
  const unavailable = () => fail(appError('browser_unavailable', 'runtime', 'The selected browser page is unavailable.', true));
  return {
    async resolveTarget(context: ProductToolContext, signal: AbortSignal) {
      const owner = context.scope.invoiceWork; if (!owner) return unavailable();
      const input = { kind: 'browser_target' as const, workId: owner.workId, itemId: owner.itemId };
      const result = parseDesktopBridgeResult(input, await request(input, signal));
      if (!result) return unavailable();
      if (!result.ok) return result;
      return result.data.kind === 'browser_target' ? ok(result.data.target) : unavailable();
    },
    async read(target: BrowserTarget, context: ProductToolContext, signal: AbortSignal, proposalId: number) {
      const owner = context.scope.invoiceWork; if (!owner) return unavailable();
      const input = { kind: 'browser_read' as const, workId: owner.workId, itemId: owner.itemId, target, proposalId };
      const result = parseDesktopBridgeResult(input, await request(input, signal));
      if (!result) return unavailable();
      if (!result.ok) return result;
      return result.data.kind === 'browser_read' ? ok(result.data.page) : unavailable();
    },
  };
}
