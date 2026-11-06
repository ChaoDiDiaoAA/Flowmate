import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { CLOUD_DESKTOP_MAX_IN_FLIGHT, CLOUD_DESKTOP_MAX_TRANSPORT_REQUESTS, CLOUD_DESKTOP_RESERVED_CONTROL,
  CloudDesktopEnvelopeSchema, appError, cloudDesktopFailure, fail, ok, parseCloudDesktopResult, type CloudDesktopEnvelope, type Result } from '@flowmate/contracts';
import { callCloudUnixRpc } from './cloud-unix-rpc.ts';

const maxFrameBytes = 1_100_000, maxResponseBytes = 14 * 1024 * 1024 + 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const frameFailure = () => fail(appError('cloud_bridge_frame_invalid', 'input', 'The cloud bridge input is invalid.'));

/** This process forwards scoped requests only; it never owns product or native execution. */
export async function runCloudDesktopBridge(input: Readable, output: Writable,
  call: (envelope: CloudDesktopEnvelope) => Promise<Result<unknown>>): Promise<Result<void>> {
  let buffered = Buffer.alloc(0), invalid = false, writeFailed = false;
  let writes: Promise<void> = Promise.resolve();
  const active = new Set<Promise<void>>(), requestIds = new Set<string>();
  const onError = () => { writeFailed = true; };
  output.on('error', onError);
  const send = (requestId: string, result: unknown): Promise<void> => {
    const frame = Buffer.from(JSON.stringify({ version: 1, requestId, result }) + '\n');
    if (frame.byteLength - 1 > maxResponseBytes) { writeFailed = true; return Promise.resolve(); }
    const pending = writes.then(() => new Promise<void>((resolve, reject) => output.write(frame, error => error ? reject(error) : resolve())));
    writes = pending.catch(() => { writeFailed = true; });
    return writes;
  };
  const receive = async (frame: Buffer): Promise<void> => {
    if (frame.byteLength > maxFrameBytes) throw Error('frame_too_large');
    const value: unknown = JSON.parse(decoder.decode(frame));
    const requestId = z.string().uuid().safeParse(value && typeof value === 'object' && 'requestId' in value ? value.requestId : undefined);
    // shortcut: reconnect after 4096 transport IDs; use a negotiated rolling window if longer sessions are needed.
    if (!requestId.success || requestIds.has(requestId.data) || requestIds.size >= CLOUD_DESKTOP_MAX_TRANSPORT_REQUESTS) throw Error('frame_identity_invalid');
    requestIds.add(requestId.data);
    const parsed = CloudDesktopEnvelopeSchema.safeParse(value);
    if (!parsed.success) { await send(requestId.data, fail(appError('input_invalid', 'input', 'The cloud desktop request is invalid.'))); return; }
    const control = parsed.data.command.type === 'personal_task_stop' || parsed.data.command.type === 'invoice_work_cancel';
    if (active.size >= (control ? CLOUD_DESKTOP_MAX_IN_FLIGHT : CLOUD_DESKTOP_MAX_IN_FLIGHT - CLOUD_DESKTOP_RESERVED_CONTROL)) {
      await send(requestId.data, fail(appError('cloud_bridge_busy', 'runtime', 'Cloud request capacity is temporarily full.', true)));
      return;
    }
    if (writeFailed) throw Error('bridge_output_failed');
    const envelope = parsed.data;
    let task: Promise<void>;
    task = (async () => {
      let result: unknown = cloudDesktopFailure(envelope.command);
      try {
        const forwarded = await call(structuredClone(envelope));
        if (forwarded.ok) {
          const parsedResult = parseCloudDesktopResult(envelope.command, forwarded.data);
          if (parsedResult) result = parsedResult;
        }
      } catch { /* A lost receipt is reconciled by its original business request. */ }
      await send(requestId.data, result);
    })().finally(() => { active.delete(task); });
    active.add(task);
  };
  try {
    for await (const chunk of input) {
      if (writeFailed || typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw Error('bridge_input_invalid');
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      for (;;) {
        const end = buffered.indexOf(10); if (end < 0) break;
        const frame = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
        await receive(frame);
      }
      if (buffered.byteLength > maxFrameBytes) throw Error('frame_too_large');
    }
    if (buffered.byteLength !== 0) throw Error('frame_truncated');
  } catch { invalid = true; }
  await Promise.all([...active]); await writes;
  output.off('error', onError);
  if (writeFailed) return fail(appError('cloud_bridge_output_unconfirmed', 'runtime', 'The original response delivery could not be confirmed.', true));
  return invalid ? frameFailure() : ok(undefined);
}

if (import.meta.main) {
  if (process.platform !== 'linux' || process.argv.length !== 2 || process.env.SSH_ORIGINAL_COMMAND)
    process.exitCode = 2;
  else {
    const result = await runCloudDesktopBridge(process.stdin, process.stdout,
      envelope => callCloudUnixRpc('/run/flowmate-authority/desktop.sock', envelope,
        envelope.command.type === 'cloud_progress_wait' ? AbortSignal.timeout(90_000) : undefined));
    if (!result.ok) { process.stderr.write('[Flowmate] cloud_bridge_failed\n'); process.exitCode = 1; }
  }
}
