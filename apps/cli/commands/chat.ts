import { createInterface, type Interface } from 'node:readline';
import { normalizeProviderRequest, type Application } from '@flowmate/contracts';
import { resolveProviderConfig, type CliIo } from './provider.ts';

export type ChatOptions = { configFile?: string; timeoutMs?: number; stopGraceMs?: number };

const help = '输入问题后回车发送；/cancel 取消当前请求；/exit 退出；/help 查看帮助。Ctrl+C：请求中取消，空闲时退出。';

/** Owns terminal input only. Application ownership and final close stay in main. */
export async function providerChatCommand(options: ChatOptions, app: Application, io: CliIo, providedTerminal?: Interface): Promise<number> {
  const config = await resolveProviderConfig(options.configFile);
  if (!config.ok) {
    io.err(`${config.error.code}: ${config.error.message}`);
    providedTerminal?.close();
    return 2;
  }
  const base = normalizeProviderRequest({ goal: '配置校验', text: '', config: config.data,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.stopGraceMs === undefined ? {} : { stopGraceMs: options.stopGraceMs }) });
  if (!base.ok) {
    io.err(`${base.error.code}: ${base.error.message}`);
    providedTerminal?.close();
    return 2;
  }
  const terminal = providedTerminal ?? createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
  let active: AbortController | null = null;
  let exiting = false;
  let exitCode = 0;
  terminal.setPrompt('你 > ');

  return new Promise<number>((resolve) => {
    const finish = () => {
      terminal.off('line', onLine);
      terminal.off('SIGINT', onInterrupt);
      terminal.off('close', onClose);
      io.signal.removeEventListener('abort', onExit);
      terminal.close();
      io.out('已退出 P1 交互。');
      resolve(exitCode);
    };
    const cancel = () => {
      if (active && !active.signal.aborted) {
        active.abort();
        io.out('已请求取消，正在等待模型请求停止……');
      } else if (!active) io.out('当前没有进行中的请求。');
    };
    const onExit = () => {
      if (exiting) return;
      exiting = true;
      if (active) cancel();
      else finish();
    };
    const onClose = () => onExit();
    const onInterrupt = () => active ? cancel() : onExit();
    const runPrompt = async (goal: string, controller: AbortController) => {
      try {
        const request = normalizeProviderRequest({ ...base.data, goal });
        if (!request.ok) { io.err(`${request.error.code}: ${request.error.message}`); return; }
        io.out('LLM 正在回复……（可输入 /cancel）');
        const result = await app.callProvider(request.data, { signal: controller.signal, onObservation: (event) => {
          if (event.type === 'provider_configured') {
            const budget = event.data.outputBudget as { selectedMaxTokens: number; modelMaxTokens: number | null; source: string };
            const source = budget.source === 'explicit' ? '显式配置' : budget.source === 'model-metadata' ? 'Pi 模型信息 + 产品默认预算' : '兜底值（模型上限未知）';
            io.out(`本次输出预算：${budget.selectedMaxTokens} Token；来源：${source}；模型上限：${budget.modelMaxTokens ?? '未知'}。`);
          }
          if (event.type === 'request_budget' && typeof event.data.wireMaxTokens === 'number'
            && event.data.wireMaxTokens !== event.data.selectedMaxTokens) {
            io.out(`Pi 调整后请求预算：${event.data.wireMaxTokens} Token。`);
          }
        } });
        if (!result.ok) { io.err(`${result.error.code}: ${result.error.message}`); return; }
        const outcome = result.data;
        if (outcome.text) io.out(`LLM > ${outcome.text}`);
        io.out(`[runId=${outcome.runId} status=${outcome.status}]`);
        if (outcome.error) io.err(`${outcome.error.code}: ${outcome.error.message}`);
        if (!outcome.stopped || outcome.cleanupErrors.length > 0) {
          io.err('runtime_cleanup_required: 请求停止或清理未确认，退出交互并关闭资源。');
          exitCode = 2;
          exiting = true;
        }
      } catch {
        // Unexpected exceptions may contain SDK credentials; only expose a safe error.
        io.err('internal_error: 请求异常，退出交互并关闭资源。');
        exitCode = 2;
        exiting = true;
      }
    };
    const onLine = (line: string) => {
      if (exiting) return;
      const input = line.trim();
      if (input === '/exit' || input === '/quit') { onExit(); return; }
      if (input === '/cancel') { cancel(); if (!active) terminal.prompt(); return; }
      if (input === '/help') { io.out(help); terminal.prompt(); return; }
      if (!input) { terminal.prompt(); return; }
      if (input.startsWith('/')) { io.err('未知命令；输入 /help 查看帮助。'); terminal.prompt(); return; }
      if (active) { io.err('当前请求尚未结束；请等待，或输入 /cancel 取消。'); return; }
      active = new AbortController();
      void runPrompt(input, active).finally(() => {
        active = null;
        if (exiting) finish();
        else terminal.prompt();
      });
    };
    terminal.on('line', onLine);
    terminal.on('SIGINT', onInterrupt);
    terminal.on('close', onClose);
    io.signal.addEventListener('abort', onExit, { once: true });
    io.out('Flowmate P1 交互式 LLM：每次提问独立，不携带上一轮历史；回复完成后显示。');
    io.out(`模型：${config.data.modelRef.model}；输出预算：${config.data.parameters.maxTokens ?? '自动选择（请求时显示数值与来源）'}。`);
    io.out(help);
    if (io.signal.aborted) onExit();
    else terminal.prompt();
  });
}
