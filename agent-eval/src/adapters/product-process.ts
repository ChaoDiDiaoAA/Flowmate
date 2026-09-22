import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProductPaths, ProviderConfig } from '@flowmate/contracts';
import type { RequestFrame, ResponseFrame } from './flowmate.ts';

type FrameListener = (frame: ResponseFrame) => void;

/**
 * The evaluation controller needs Langfuse credentials, but the product child
 * never does. Fixture runs must also be unable to accidentally invoke a real
 * provider because the developer happened to configure one in `.env`.
 */
export function productChildEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  mode: 'fixture' | 'live',
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  delete env.LANGFUSE_SECRET_KEY;
  delete env.LANGFUSE_PUBLIC_KEY;
  delete env.LANGFUSE_BASE_URL;
  if (mode === 'fixture') {
    delete env.FLOWMATE_LLM_BASE_URL;
    delete env.FLOWMATE_LLM_MODEL;
    delete env.FLOWMATE_LLM_API_KEY;
    delete env.FLOWMATE_LLM_API;
  }
  return env;
}

/**
 * Bun loads a cwd .env file by default. The controller has already chosen
 * exactly which variables cross into the product child, so suppress that
 * second load to keep Fixture and Langfuse credentials isolated.
 */
export function productChildArguments(server: string): string[] {
  return ['--no-env-file', 'run', server];
}

export class ProductProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private requestId = 0;
  private readonly frames: ResponseFrame[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<FrameListener>();
  private stderr = '';

  public constructor(private readonly identity: { executionId: string; trialId: string }) {}

  public get timeline(): readonly ResponseFrame[] { return this.frames; }
  public get diagnostics(): string { return this.stderr; }

  public async start(input: { paths: ProductPaths; productConfig: ProviderConfig; mode: 'fixture' | 'live'; faultProfile: string }): Promise<void> {
    const server = resolve(dirname(fileURLToPath(import.meta.url)), 'product-server.ts');
    const env = productChildEnvironment(process.env, input.mode);
    this.child = spawn('bun', productChildArguments(server), { cwd: resolve(dirname(server), '../../..'), env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const output = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    void (async () => {
      for await (const line of output) {
        try {
          const frame = JSON.parse(line) as ResponseFrame;
          this.frames.push(frame);
          for (const listener of this.listeners) listener(frame);
          for (const wake of [...this.waiters]) wake();
        } catch {
          this.stderr += `invalid stdout protocol frame: ${line}\n`;
        }
      }
    })();
    void (async () => {
      for await (const chunk of this.child!.stderr) this.stderr += String(chunk);
    })();
    const requestId = this.send('start', { ...input, controlVersion: 1 });
    const frame = await this.waitFor((item) => item.requestId === requestId && (item.type === 'ready' || item.type === 'error'), 10_000);
    if (frame.type !== 'ready') throw new Error(`Product start failed: ${JSON.stringify(frame.data)}`);
  }

  public beginProvider(payload: { goal: string; text: string; timeoutMs: number; stopGraceMs: number }): { requestId: number; result: Promise<ResponseFrame> } {
    const requestId = this.send('call_provider', payload);
    return { requestId, result: this.waitFor((frame) => frame.requestId === requestId && (frame.type === 'result' || frame.type === 'error'), payload.timeoutMs + payload.stopGraceMs + 10_000) };
  }

  public async waitForEvent(requestId: number, eventType: string, timeoutMs = 10_000): Promise<ResponseFrame> {
    return this.waitFor((frame) => frame.requestId === requestId && frame.type === 'event' && (frame.data.event as { type?: string } | undefined)?.type === eventType, timeoutMs);
  }

  public async cancel(targetRequestId: number, runId?: number): Promise<ResponseFrame> {
    const requestId = this.send('cancel', { targetRequestId, ...(runId === undefined ? {} : { runId }) });
    return this.waitFor((frame) => frame.requestId === requestId && (frame.type === 'cancel_ack' || frame.type === 'error'), 5_000);
  }

  public async query(runId: number): Promise<ResponseFrame> {
    const requestId = this.send('query', { runId });
    return this.waitFor((frame) => frame.requestId === requestId && (frame.type === 'result' || frame.type === 'error'), 5_000);
  }

  public async close(): Promise<ResponseFrame> {
    if (!this.child) throw new Error('Product process was not started');
    const requestId = this.send('close', {});
    const frame = await this.waitFor((item) => item.requestId === requestId && (item.type === 'closed' || item.type === 'error'), 10_000);
    this.child.stdin.end();
    return frame;
  }

  public onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private send(command: RequestFrame['command'], payload: Record<string, unknown>): number {
    if (!this.child) throw new Error('Product process is not running');
    const requestId = ++this.requestId;
    const frame: RequestFrame = { protocol: 'flowmate-eval/v1', ...this.identity, requestId, command, payload };
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
    return requestId;
  }

  private async waitFor(predicate: (frame: ResponseFrame) => boolean, timeoutMs: number): Promise<ResponseFrame> {
    const existing = this.frames.find(predicate);
    if (existing) return existing;
    return new Promise<ResponseFrame>((resolvePromise, reject) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`Timed out waiting for product frame after ${timeoutMs} ms`));
      }, timeoutMs);
      const check = () => {
        const match = this.frames.find(predicate);
        if (!match) return;
        clearTimeout(timeout);
        this.waiters.delete(check);
        resolvePromise(match);
      };
      this.waiters.add(check);
    });
  }
}
