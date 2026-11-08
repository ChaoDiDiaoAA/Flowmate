import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { appError, fail, ok, type CloudRuntimeBinding, type DurableProductToolDefinition, type Result } from '@flowmate/contracts';
import { CloudRuntimeToolsSchema, createCloudAuthorityCallbacksClient, createCloudAuthorityRpcClient } from './cloud-authority-rpc.ts';
import { callCloudModelSocket } from './cloud-model-socket.ts';
import { createCloudRuntimeRouter } from './cloud-runtime-router.ts';
import { createCloudRuntimeRpcHandler } from './cloud-runtime-rpc.ts';
import { openCloudRuntimeStore } from './cloud-runtime-storage.ts';
import type { CloudRuntimeSession } from './cloud-runtime-storage.ts';
import { listenCloudUnixRpc } from './cloud-unix-rpc.ts';
import { CloudWakeScheduler } from './cloud-wake-scheduler.ts';

const optionsSchema = z.object({ root: z.string().min(1), runtimeSocketPath: z.string().min(1), authoritySocketPath: z.string().min(1),
  modelSocketPath: z.string().min(1), tools: CloudRuntimeToolsSchema }).strict();

/** A Runtime process owns only native Sessions and communicates with Authority through its sockets. */
export async function createCloudRuntimeService(raw: { root: string; runtimeSocketPath: string; authoritySocketPath: string;
  modelSocketPath: string; tools: readonly DurableProductToolDefinition[] }): Promise<Result<{ close(): Promise<Result<void>> }>> {
  if (process.platform !== 'linux') return fail(appError('cloud_runtime_platform_invalid', 'runtime', 'The cloud Runtime requires Linux.'));
  const parsed = optionsSchema.safeParse(raw);
  if (!parsed.success) return fail(appError('input_invalid', 'input', 'The cloud Runtime configuration is invalid.'));
  const options = parsed.data, store = await openCloudRuntimeStore(options.root); if (!store.ok) return store;
  const discovered = await store.data.listBindings();
  if (!discovered.ok) { await store.data.close(); return discovered; }
  const authority = createCloudAuthorityCallbacksClient(options.authoritySocketPath), notifications = new Set<Promise<unknown>>(), runtimeGeneration = randomUUID();
  const abort = new AbortController(); let shutting = false;
  const recoveryTimers = new Set<ReturnType<typeof setTimeout>>();
  type Lane = { session: CloudRuntimeSession; running?: Promise<void>; pending: boolean; timer?: ReturnType<typeof setTimeout>;
    progressPending?: boolean; progressRunning?: Promise<void> };
  const lanes = new Map<string, Lane>();
  const kick = (runtimeId: string, lane: Lane) => {
    if (shutting) return;
    lane.pending = true; if (lane.running) return;
    if (lane.timer) { clearTimeout(lane.timer); lane.timer = undefined; }
    lane.running = (async () => {
      while (lane.pending && !shutting) {
        lane.pending = false;
        const due = await lane.session.pendingResults(); if (!due.ok) return;
        for (const { event, attempts } of due.data) {
          if (shutting) return;
          const receipt = await authority.deliverNativeResult(event, abort.signal);
          if (shutting) return;
          if (receipt.ok) { const saved = await lane.session.acknowledgeResult(event, receipt.data); if (!saved.ok) return; }
          else {
            const now = Date.now(), next = now + Math.min(60_000, 1000 * 2 ** attempts);
            const saved = await lane.session.recordDeliveryFailure(event, { deliveryId: randomUUID(), at: new Date(now).toISOString(),
              nextAt: new Date(next).toISOString() });
            if (!saved.ok) return;
          }
        }
      }
      if (shutting) return;
      const next = await lane.session.nextResultRetry();
      if (next.ok && next.data !== null) lane.timer = setTimeout(() => { lane.timer = undefined; kick(runtimeId, lane); },
        Math.max(0, Math.min(2_147_483_647, next.data - Date.now())));
    })().catch(() => { /* The original native result remains in the outbox. */ }).finally(() => {
      lane.running = undefined; if (lane.pending && !shutting) kick(runtimeId, lane);
    });
  };
  const notifyProgress = (binding: CloudRuntimeBinding, lane: Lane) => {
    if (shutting) return;
    lane.progressPending = true; if (lane.progressRunning) return;
    const pending = (async () => {
      while (lane.progressPending && !shutting) {
        lane.progressPending = false;
        const revision = await lane.session.bumpObservation(); if (!revision.ok || shutting) return;
        await authority.notifyRuntimeChanged({ ...binding, runtimeGeneration, observationRevision: revision.data }, abort.signal);
      }
    })().catch(() => { /* The desktop can re-read its authoritative snapshot. */ }).finally(() => {
      lane.progressRunning = undefined; notifications.delete(pending);
      if (lane.progressPending && !shutting) notifyProgress(binding, lane);
    });
    lane.progressRunning = pending; notifications.add(pending);
  };
  let router!: ReturnType<typeof createCloudRuntimeRouter>;
  const wakes = new CloudWakeScheduler((binding, attemptId) => router.wakeSession({ workId: binding.workId, sessionId: binding.sessionId, attemptId }));
  router = createCloudRuntimeRouter({ store: store.data, runtimeGeneration, authorize: createCloudAuthorityRpcClient(options.authoritySocketPath),
    onResultRetry: async (binding, session) => {
      let lane = lanes.get(binding.cloudRuntimeId);
      if (!lane) {
        const recovered = await router.recoverSession({ workId: binding.workId, sessionId: binding.sessionId }); if (!recovered.ok) return recovered;
        lane = lanes.get(binding.cloudRuntimeId);
      }
      if (!lane || lane.session !== session) return fail(appError('cloud_result_unavailable', 'runtime', 'The original result owner is unavailable.', true));
      kick(binding.cloudRuntimeId, lane); return ok(undefined);
    },
    beforeSchedule: async (binding, session, request) => {
      const lane = lanes.get(binding.cloudRuntimeId);
      if (!lane || lane.session !== session) return fail(appError('cloud_wake_unavailable', 'runtime', 'The original wake owner is unavailable.', true));
      return wakes.arm(binding, session, { attemptId: request.attemptId, ...(request.requestId === undefined ? {} : { requestId: request.requestId }) });
    },
    runtimeOptions: (binding, session) => {
      const lane: Lane = { session, pending: false }; lanes.set(binding.cloudRuntimeId, lane); kick(binding.cloudRuntimeId, lane);
      void wakes.register(binding, session);
      return {
      readApiKey: () => undefined, verifyModelUse: input => authority.verifyModelUse(input),
      verifySchedulingUse: (input, pending) => authority.verifySchedulingUse(input, pending),
      reserveModelRequest: () => fail(appError('cloud_model_transport_unavailable', 'runtime', 'Cloud model quota is reserved by the Authority proxy.')),
      readWorkingContext: input => authority.readWorkingContext(input), verifyWorkingContext: input => authority.verifyWorkingContext(input),
      readMemory: input => authority.readMemory!(input),
      approvalWait: authority.approvalWait,
      verifyQueueInputs: input => authority.verifyQueueInputs(input),
      tools: options.tools, executeTool: input => authority.executeTool(input), readToolResult: input => authority.readToolResult(input),
      onToolFeedback: input => authority.onToolFeedback(input), subagents: authority.subagents, compactions: authority.compactions,
      cloudModel: { binding, send: (input, signal) => callCloudModelSocket(options.modelSocketPath, input, signal) },
      onNativeResult: async event => { const saved = await session.enqueueResult(event); if (saved.ok) kick(binding.cloudRuntimeId, lane); return saved; },
      onNativeResultOversized: event => session.enqueueOversizedResult(event),
      onWake: wake => wakes.observe(binding, wake),
      onChanged: () => notifyProgress(binding, lane),
    }; } });
  const server = await listenCloudUnixRpc({ socketPath: options.runtimeSocketPath, allowStaleSocket: true, handle: createCloudRuntimeRpcHandler(router) });
  if (!server.ok) { const wakeClosed = await wakes.close(), closed = await router.close();
    if (!wakeClosed.ok) return wakeClosed; if (!closed.ok) return closed; await store.data.close(); return server; }
  const recover = (binding: typeof discovered.data[number]['binding'], attempt = 0) => {
    if (shutting) return;
    const operation = (async () => {
      const read = await router.recoverSession({ workId: binding.workId, sessionId: binding.sessionId });
      const session = read.ok ? await store.data.openSession(binding, false) : read;
      const revision = session.ok ? await session.data.readObservation() : session;
      const notified = revision.ok ? await authority.notifyRuntimeChanged({ ...binding, runtimeGeneration, observationRevision: revision.data }, abort.signal) : revision;
      if (!notified.ok && !shutting) {
        const timer = setTimeout(() => { recoveryTimers.delete(timer); recover(binding, attempt + 1); }, Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6)));
        recoveryTimers.add(timer);
      }
    })();
    notifications.add(operation); void operation.then(() => notifications.delete(operation), () => notifications.delete(operation));
  };
  for (const original of discovered.data) if (original.state === 'ready') recover(original.binding);
  let closing: Promise<Result<void>> | undefined;
  return ok({ close() {
    closing ??= (async () => {
      shutting = true; abort.abort();
      for (const lane of lanes.values()) if (lane.timer) clearTimeout(lane.timer);
      for (const timer of recoveryTimers) clearTimeout(timer);
      const stopping = server.data.close(), wakeClosed = await wakes.close(), native = await router.close();
      if (!wakeClosed.ok) return wakeClosed;
      const stopped = await stopping; if (!native.ok) return native; if (!stopped.ok) return stopped;
      await Promise.allSettled([...lanes.values()].flatMap(lane => lane.running ? [lane.running] : []));
      await Promise.allSettled([...notifications]);
      return store.data.close();
    })(); return closing;
  } });
}
