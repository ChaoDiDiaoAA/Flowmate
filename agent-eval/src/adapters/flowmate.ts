import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Application, ProductPaths, ProviderConfig, Result } from '@flowmate/contracts';

export type RequestFrame = {
  protocol: 'flowmate-eval/v1';
  executionId: string;
  trialId: string;
  requestId: number;
  command: 'start' | 'call_provider' | 'cancel' | 'query' | 'close';
  payload: Record<string, unknown>;
};

export type ResponseFrame = {
  protocol: 'flowmate-eval/v1';
  executionId: string;
  trialId: string;
  requestId: number;
  type: 'ready' | 'event' | 'result' | 'error' | 'cancel_ack' | 'stopped' | 'closed';
  data: Record<string, unknown>;
};

type StartPayload = {
  paths: ProductPaths;
  productConfig: ProviderConfig;
  mode: 'fixture' | 'live';
  faultProfile: string;
  controlVersion: 1;
};

type Active = { controller: AbortController; runId: number | null; terminal: boolean; completion: Promise<void> };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateTrial(frame: RequestFrame, paths: ProductPaths): void {
  if (!isAbsolute(paths.root) || !existsSync(paths.root)) throw new Error('Trial root must already exist and be absolute');
  const root = realpathSync(paths.root);
  const markerPath = join(root, '.flowmate-trial-owner.json');
  if (!existsSync(markerPath)) throw new Error('Trial owner marker is missing');
  const owner = JSON.parse(readFileSync(markerPath, 'utf8')) as { executionId?: string; trialId?: string; root?: string };
  if (owner.executionId !== frame.executionId || owner.trialId !== frame.trialId || resolve(owner.root ?? '') !== root) {
    throw new Error('Trial owner marker does not match the protocol identity');
  }
  for (const path of Object.values(paths)) {
    if (!isAbsolute(path)) throw new Error('Every ProductPaths value must be absolute');
    const rel = relative(root, resolve(path));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('ProductPaths cannot escape the Trial root');
  }
  if (resolve(paths.databaseFile) !== resolve(root, 'data', `${frame.trialId}.sqlite`)) {
    throw new Error('Trial database must be data/<trialId>.sqlite');
  }
}

export async function serve(
  lines: AsyncIterable<string>,
  write: (frame: ResponseFrame) => void,
  dependencies: { createApp: (start: StartPayload) => Promise<Result<Application>> },
): Promise<void> {
  let identity: Pick<RequestFrame, 'executionId' | 'trialId'> | null = null;
  let app: Application | null = null;
  let startPayload: StartPayload | null = null;
  const active = new Map<number, Active>();
  const emit = (frame: RequestFrame, type: ResponseFrame['type'], data: Record<string, unknown>) => write({
    protocol: 'flowmate-eval/v1', executionId: frame.executionId, trialId: frame.trialId, requestId: frame.requestId, type, data,
  });

  for await (const line of lines) {
    let frame: RequestFrame;
    try {
      frame = JSON.parse(line) as RequestFrame;
      if (frame.protocol !== 'flowmate-eval/v1' || !Number.isSafeInteger(frame.requestId)) throw new Error('invalid protocol envelope');
      if (identity && (identity.executionId !== frame.executionId || identity.trialId !== frame.trialId)) throw new Error('protocol identity changed');
    } catch (error) {
      const fallback: RequestFrame = { protocol: 'flowmate-eval/v1', executionId: identity?.executionId ?? 'unknown', trialId: identity?.trialId ?? 'unknown', requestId: 0, command: 'close', payload: {} };
      emit(fallback, 'error', { code: 'protocol_error', message: errorText(error) });
      continue;
    }

    if (frame.command === 'start') {
      try {
        if (app || identity) throw new Error('start may only be sent once');
        startPayload = frame.payload as StartPayload;
        validateTrial(frame, startPayload.paths);
        identity = { executionId: frame.executionId, trialId: frame.trialId };
        const opened = await dependencies.createApp(startPayload);
        if (!opened.ok) throw new Error(`${opened.error.code}: ${opened.error.message}`);
        app = opened.data;
        emit(frame, 'ready', { mode: startPayload.mode, controlVersion: 1 });
      } catch (error) {
        emit(frame, 'error', { code: 'start_invalid', message: errorText(error) });
      }
      continue;
    }

    if (!app || !startPayload) {
      emit(frame, 'error', { code: 'not_started', message: 'start is required before other commands' });
      continue;
    }

    if (frame.command === 'call_provider') {
      const controller = new AbortController();
      const current: Active = { controller, runId: null, terminal: false, completion: Promise.resolve() };
      active.set(frame.requestId, current);
      const completion = app.callProvider({
        goal: String(frame.payload.goal ?? ''),
        text: String(frame.payload.text ?? ''),
        config: startPayload.productConfig,
        timeoutMs: Number(frame.payload.timeoutMs),
        stopGraceMs: Number(frame.payload.stopGraceMs),
      }, {
        signal: controller.signal,
        onObservation: (event) => {
          current.runId = event.runId;
          if (event.type === 'stopped') current.terminal = true;
          emit(frame, event.type === 'stopped' ? 'stopped' : 'event', event.type === 'stopped' ? { ...event.data, event } : { event });
        },
      }).then((outcome) => {
        current.terminal = true;
        const runId = outcome.ok ? outcome.data.runId : outcome.runId ?? outcome.error.runId ?? null;
        if (runId !== null) current.runId = runId;
        emit(frame, 'result', { outcome });
      }).catch((error) => {
        current.terminal = true;
        emit(frame, 'error', { code: 'call_failed', message: errorText(error) });
      });
      current.completion = completion;
      continue;
    }

    if (frame.command === 'cancel') {
      const targetRequestId = Number(frame.payload.targetRequestId);
      const target = active.get(targetRequestId);
      const suppliedRunId = frame.payload.runId === undefined ? null : Number(frame.payload.runId);
      if (!target || (suppliedRunId !== null && target.runId !== suppliedRunId)) {
        emit(frame, 'error', { code: 'cancel_run_mismatch', message: 'Cancellation target does not match the observed request/run binding' });
      } else if (target.terminal) {
        emit(frame, 'cancel_ack', { accepted: false, reason: 'already_terminal', targetRequestId, runId: target.runId });
      } else {
        target.controller.abort('user');
        emit(frame, 'cancel_ack', { accepted: true, targetRequestId, runId: target.runId });
      }
      continue;
    }

    if (frame.command === 'query') {
      const runId = Number(frame.payload.runId);
      const result = await app.queryRun(runId);
      emit(frame, 'result', { outcome: result });
      continue;
    }

    if (frame.command === 'close') {
      const result = await app.close();
      emit(frame, 'closed', { outcome: result, stopped: result.ok && result.data.stopped, closed: result.ok && result.data.closed, errors: result.ok ? result.data.errors : [result.error] });
      app = null;
      break;
    }
  }
}
