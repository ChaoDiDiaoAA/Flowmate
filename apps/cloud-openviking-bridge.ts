import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import { appError, CLOUD_DESKTOP_MAX_TRANSPORT_REQUESTS, fail, ok, type Result } from '@flowmate/contracts';
import {
  CLOUD_OPENVIKING_REQUEST_LIMIT, CLOUD_OPENVIKING_RESPONSE_LIMIT,
  CloudOpenVikingManagementEnvelopeSchema, parseCloudOpenVikingManagementResult,
} from '../packages/contracts/src/cloud-openviking-management.ts';
import { OpenVikingManagementRoleSchema } from '../packages/contracts/src/openviking-management.ts';
import { cloudOpenVikingSockets } from './cloud-openviking-sockets.ts';
import { callCloudUnixRpc } from './cloud-unix-rpc.ts';

const decoder = new TextDecoder('utf-8', { fatal: true });
const invalid = () => fail(appError('input_invalid', 'input', 'The cloud OpenViking request is invalid.'));
const unknown = () => fail(appError('operation_result_unknown', 'runtime', 'The original cloud OpenViking response could not be confirmed.', true));
const frameId = z.object({ requestId: z.string().uuid() }).passthrough();

export async function runCloudOpenVikingBridge(input: Readable, output: Writable,
  call: (value: z.infer<typeof CloudOpenVikingManagementEnvelopeSchema>) => Promise<Result<unknown>>): Promise<Result<void>> {
  let pending = Buffer.alloc(0), failedOutput = false;
  const requestIds = new Set<string>();
  const onError = () => { failedOutput = true; };
  output.on('error', onError);
  try {
    for await (const chunk of input) {
      if (failedOutput || typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) throw Error('invalid_openviking_frame');
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      for (;;) {
        const end = pending.indexOf(10);
        if (end < 0) break;
        if (end > CLOUD_OPENVIKING_REQUEST_LIMIT) throw Error('openviking_frame_too_large');
        const raw: unknown = JSON.parse(decoder.decode(pending.subarray(0, end)));
        pending = pending.subarray(end + 1);
        const id = frameId.parse(raw).requestId;
        if (requestIds.has(id) || requestIds.size >= CLOUD_DESKTOP_MAX_TRANSPORT_REQUESTS) throw Error('openviking_frame_identity_invalid');
        requestIds.add(id);
        const envelope = CloudOpenVikingManagementEnvelopeSchema.safeParse(raw);
        let result: Result<unknown> = invalid();
        if (envelope.success) {
          result = unknown();
          try {
            const response = await call(envelope.data);
            if (response.ok) result = parseCloudOpenVikingManagementResult({ version: 1, requestId: id, result: response.data }, id) ?? result;
          } catch { /* Preserve the original operation's unknown outcome. */ }
        }
        let frame = Buffer.from(JSON.stringify({ version: 1, requestId: id, result }) + '\n');
        if (frame.length - 1 > CLOUD_OPENVIKING_RESPONSE_LIMIT)
          frame = Buffer.from(JSON.stringify({ version: 1, requestId: id, result: unknown() }) + '\n');
        try {
          await new Promise<void>((resolve, reject) => output.write(frame, error => error ? reject(error) : resolve()));
          if (failedOutput) throw Error('openviking_frame_output_failed');
        } catch (error) { failedOutput = true; throw error; }
      }
      if (pending.length > CLOUD_OPENVIKING_REQUEST_LIMIT) throw Error('openviking_frame_too_large');
    }
    if (pending.length) throw Error('openviking_frame_truncated');
    return ok(undefined);
  } catch {
    return failedOutput
      ? fail(appError('cloud_bridge_output_unconfirmed', 'runtime', 'The original OpenViking response delivery could not be confirmed.', true))
      : fail(appError('cloud_bridge_frame_invalid', 'input', 'The cloud OpenViking bridge input is invalid.'));
  } finally { output.off('error', onError); }
}

if (import.meta.main) {
  const role = OpenVikingManagementRoleSchema.safeParse(process.argv[2]);
  if (process.platform !== 'linux' || process.argv.length !== 3 || !role.success || process.env.SSH_ORIGINAL_COMMAND)
    process.exitCode = 2;
  else {
    const result = await runCloudOpenVikingBridge(process.stdin, process.stdout, value =>
      callCloudUnixRpc(cloudOpenVikingSockets[role.data], value, AbortSignal.timeout(value.command.type === 'execute' ? 320_000 : 30_000)));
    if (!result.ok) { process.stderr.write('[Flowmate] cloud_openviking_bridge_failed\n'); process.exitCode = 1; }
  }
}
