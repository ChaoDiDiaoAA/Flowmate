import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { resolveRuntimeLayout } from '../../../packages/shared/src/runtime-layout.ts';
import type { EvaluationRuntime } from '../../../agent-eval/src/execution/source.ts';
import { appError, fail, ok, evaluationRequests, matchesEvaluationResponse, parseEvaluationCommand,
  type EvaluationConfigurationSnapshot, type EvaluationControlState, type EvaluationEvent,
  type EvaluationPreview, type Result } from '@flowmate/contracts';
import { EVALUATION_FRAME_LIMIT, parseEvaluationWorkerCommand, parseEvaluationWorkerOutput,
  type EvaluationWorkerCommand, type EvaluationWorkerData, type EvaluationWorkerOperation } from '../../../agent-eval/src/desktop/protocol.ts';
import { registerSecrets, scanEvidence } from '../../../agent-eval/src/execution/evidence-safety.ts';
import type { EvaluationStartContext } from '../../../agent-eval/src/desktop/service.ts';
import { safeChildEnvironment } from './host-client.ts';
import { langfuseConfig, type LangfuseConnection, type EvaluationAgentCredential } from '../../../agent-eval/src/configuration.ts';
import { EvaluationWorkflowRequestSchema, isWorkflowReadOnly, type EvaluationWorkflowResult } from '../../../packages/contracts/src/evaluation-workflow.ts';

type Fields<K extends EvaluationWorkerOperation> = Omit<Extract<EvaluationWorkerCommand, { type: K }>, 'version' | 'sessionId' | 'messageId' | 'type'>;
type Pending = { operation: EvaluationWorkerOperation; command: ReturnType<typeof parseEvaluationCommand>;
  workflowAction?: string;
  resolve(value: Result<EvaluationWorkerData<EvaluationWorkerOperation>>): void; timer: ReturnType<typeof setTimeout> | undefined };
type Start = { previewId: string; batchId: string; sent: boolean; cancelled: boolean; control: EvaluationControlState;
  promise: Promise<Result<EvaluationControlState>> };
type PrepareStart = (preview: EvaluationPreview) => Promise<Result<Omit<EvaluationStartContext, 'batchId'>>>;
type PrepareExport = () => Result<LangfuseConnection> | Promise<Result<LangfuseConnection>>;
const active = (state: EvaluationControlState | null) => !!state && ['preparing', 'running', 'cancelling', 'interrupted', 'stop-unconfirmed'].includes(state.state);
const failure = (code: string, message: string) => fail(appError(code, 'runtime', message, true));
const CLOSE_TIMEOUT_MS = 15_000;
export type EvaluationWorkerLaunch = { executable: string; entry: string; cwd: string; runtime: EvaluationRuntime };

export function retainEvaluationControl(current: EvaluationControlState | null, sequence: number,
  incoming: EvaluationControlState, incomingSequence: number): EvaluationControlState {
  return structuredClone(current && current.sessionId === incoming.sessionId && current.batchId === incoming.batchId && incomingSequence < sequence ? current : incoming);
}

export class EvaluationClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startup: Promise<Result<void>> | null = null;
  private exited: Promise<void> = Promise.resolve();
  private sessionId = randomUUID();
  private workerSequence = 0;
  private publicationSequence = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly starts = new Map<string, Start>();
  private readonly listeners = new Set<(event: EvaluationEvent) => void>();
  private current: EvaluationControlState | null = null;
  private latestPreview: EvaluationPreview | null = null;
  private closing = false;
  private crashBlocked = false;
  private closeAcknowledged = false;
  private exporting = false;
  private workflowWriting = false;
  private readonly capturedTraces = new Set<string>();
  private processingCapturedTraces = false;
  private readonly exports = new Map<string, { executionId: string; promise: Promise<Result<EvaluationWorkerData<'export_evaluation'>>> }>();

  constructor(private readonly repository: string, private readonly evaluationRepository = repository, private readonly launch?: EvaluationWorkerLaunch) {}
  public get state(): EvaluationControlState | null { return this.current ? structuredClone(this.current) : null; }
  public get canRestartHost(): boolean { return !this.closing && !this.exporting && !this.workflowWriting && !this.crashBlocked && !active(this.current); }
  public subscribe(listener: (event: EvaluationEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private publish(control: EvaluationControlState, replace = false) {
    const safe = scanEvidence(structuredClone(control)).value;
    if (control.requestId) { const start = this.starts.get(control.requestId); if (start) start.control = safe; }
    if (!replace && this.current && this.current.batchId !== control.batchId) return;
    this.current = safe;
    const event: EvaluationEvent = { version: 1, sessionId: control.sessionId, sequence: ++this.publicationSequence, control: this.current };
    for (const listener of this.listeners) { try { listener(structuredClone(event)); } catch { /* Display cannot change the controller. */ } }
    void this.flushCapturedTraces();
  }
  public enqueueTrace(traceId: string): void {
    if (this.closing || !EvaluationWorkflowRequestSchema.safeParse({ action: 'trace.process', traceId }).success) return;
    this.capturedTraces.add(traceId); void this.flushCapturedTraces();
  }
  private async flushCapturedTraces(): Promise<void> {
    if (this.processingCapturedTraces) return;
    this.processingCapturedTraces = true;
    try {
      while (this.capturedTraces.size && this.canRestartHost) {
        const traceId = this.capturedTraces.values().next().value!; this.capturedTraces.delete(traceId);
        const result = await this.workflow({ action: 'trace.process', traceId });
        if (!result.ok && result.error.code === 'evaluation_busy') { this.capturedTraces.add(traceId); break; }
      }
    } finally { this.processingCapturedTraces = false; }
  }
  private interrupted() {
    if (active(this.current)) this.publish({ ...this.current!, state: 'interrupted', stop: 'unconfirmed',
      errors: [...this.current!.errors, '评测连接中断，原执行与停止事实需核对。'] });
  }
  private failPending(code: string, message: string) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve(failure(code, message)); }
    this.pending.clear();
  }
  private ensureReady(): Promise<Result<void>> {
    if (this.child && this.startup) return this.startup;
    if (this.closing) return Promise.resolve(failure('evaluation_worker_unavailable', '评测查询通道已关闭。'));
    const installed = this.launch?.runtime.mode === 'installed' ? this.launch.runtime : null;
    if (installed) {
      const layout = installed.layout;
      const checked = resolveRuntimeLayout({ isPackaged: true, appPath: join(layout.runtimeRoot, '../app.asar'),
        resourcesPath: join(layout.runtimeRoot, '..'), userDataRoot: join(layout.evaluationRoot, '..') });
      if (!checked.ok || layout.evaluationRoot !== this.evaluationRepository || this.launch!.entry !== layout.workerLauncher
        || this.launch!.executable !== layout.bunExecutable || this.launch!.cwd !== layout.runtimeRoot
        || checked.data.release?.releaseId !== installed.release.releaseId)
        return Promise.resolve(failure('installation_runtime_invalid', '评测安装运行资源无效。'));
      try { mkdirSync(this.evaluationRepository, { recursive: true }); }
      catch { return Promise.resolve(failure('evaluation_worker_unavailable', '评测数据目录不可写。')); }
    }
    this.sessionId = randomUUID(); this.workerSequence = 0; this.publicationSequence = 0; this.closeAcknowledged = false;
    const session = this.sessionId, child = spawn(this.launch?.executable ?? (process.env.FLOWMATE_BUN_EXECUTABLE?.trim() || 'bun'),
      ['--no-env-file', this.launch?.entry ?? join(this.repository, 'agent-eval/src/desktop/worker.ts'), '--repo', this.evaluationRepository,
        ...(installed ? ['--runtime-root', installed.layout.runtimeRoot] : []), '--session-id', session],
      { cwd: this.launch?.cwd ?? this.repository, env: safeChildEnvironment(false), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let settle!: (value: Result<void>) => void, settled = false;
    const ready = new Promise<Result<void>>(done => { settle = done; }); this.startup = ready;
    const finish = (value: Result<void>) => { if (!settled) { settled = true; clearTimeout(timer); settle(value); } };
    const timer = setTimeout(() => finish(failure('evaluation_worker_timeout', '评测进程尚未就绪；保留原连接，不自动重启。')), 20_000);
    this.exited = new Promise<void>(done => child.once('exit', () => {
      if (this.child === child) {
        if (!this.closeAcknowledged && (active(this.current) || this.workflowWriting)) { this.crashBlocked = true; this.interrupted(); }
        this.child = null; this.startup = null; this.latestPreview = null;
        finish(failure('evaluation_worker_exited', '评测进程已退出。')); this.failPending('evaluation_worker_exited', '评测进程已退出，原请求结果未知。');
      }
      done();
    }));
    child.on('error', () => { finish(failure('evaluation_worker_unavailable', '固定评测进程无法启动。')); this.failPending('evaluation_worker_unavailable', '评测进程不可用。'); });
    child.stdin.on('error', () => { this.failPending('evaluation_write_failed', '评测通道写入失败，原请求结果未知。'); this.interrupted(); });
    child.stderr.on('data', () => { process.stderr.write('[Flowmate Evaluation] Worker reported an error.\n'); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (this.child !== child) return;
      let output: ReturnType<typeof parseEvaluationWorkerOutput> = null;
      try { if (Buffer.byteLength(line) <= EVALUATION_FRAME_LIMIT) output = parseEvaluationWorkerOutput(JSON.parse(line)); } catch { /* No raw frame logging. */ }
      if (!output || output.sessionId !== session) { this.failPending('evaluation_protocol_invalid', '评测回复身份或结构无效。'); this.interrupted(); return; }
      if (output.type === 'ready') { finish(ok(undefined)); return; }
      if (output.type === 'protocol-error') { this.failPending('evaluation_protocol_invalid', '评测进程拒绝非法消息。'); this.interrupted(); return; }
      if (output.type === 'event') {
        if (output.event.sequence <= this.workerSequence) return;
        const control = output.event.control, start = control.requestId ? this.starts.get(control.requestId) : null;
        if (!start || start.batchId !== control.batchId) return;
        this.workerSequence = output.event.sequence; this.publish(control); return;
      }
      const pending = this.pending.get(output.messageId); if (!pending) return;
      if (pending.operation !== output.operation || pending.command && !matchesEvaluationResponse(pending.command, output.result as Result<EvaluationControlState | EvaluationPreview>)
        || pending.workflowAction && output.result.ok && (!('action' in output.result.data) || output.result.data.action !== pending.workflowAction)) {
        clearTimeout(pending.timer); this.pending.delete(output.messageId); pending.resolve(failure('evaluation_protocol_invalid', '评测回复不属于原请求。')); this.interrupted(); return;
      }
      if (output.operation === 'shutdown' && output.result.ok && output.result.data.closed && output.result.data.stopped) this.closeAcknowledged = true;
      let result: Result<EvaluationWorkerData<EvaluationWorkerOperation>> = scanEvidence(output.result).value;
      if (result.ok && 'batchId' in result.data) {
        const previous = result.data.requestId ? this.starts.get(result.data.requestId) : null;
        if (result.data.state !== 'idle' && (!previous || previous.batchId !== result.data.batchId)) {
          clearTimeout(pending.timer); this.pending.delete(output.messageId); pending.resolve(failure('evaluation_protocol_invalid', '评测批次回复身份无效。')); this.interrupted(); return;
        }
        result = ok(retainEvaluationControl(previous?.control ?? this.current, this.workerSequence, result.data, output.sequence));
      }
      this.workerSequence = Math.max(this.workerSequence, output.sequence);
      clearTimeout(pending.timer); this.pending.delete(output.messageId); pending.resolve(result);
    });
    child.once('close', () => lines.close());
    return ready;
  }
  private request<K extends EvaluationWorkerOperation>(operation: K, fields: Fields<K>, timeoutMs: number | null = 10_000): Promise<Result<EvaluationWorkerData<K>>> {
    const child = this.child, messageId = randomUUID();
    if (!child || !child.stdin.writable || child.stdin.destroyed) return Promise.resolve(failure('evaluation_worker_unavailable', '评测通道不可写。'));
    const command = parseEvaluationWorkerCommand({ ...fields, type: operation, version: 1, sessionId: this.sessionId, messageId });
    if (!command) return Promise.resolve(failure('input_invalid', '评测私有消息无效。'));
    const line = JSON.stringify(command) + '\n';
    if (Buffer.byteLength(line) > EVALUATION_FRAME_LIMIT) return Promise.resolve(failure('input_invalid', '评测请求超过传输容量。'));
    return new Promise(resolve => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => { this.pending.delete(messageId); resolve(failure('evaluation_response_unknown', '评测响应未知，请查询原请求。')); }, timeoutMs);
      this.pending.set(messageId, { operation, command: operation === 'shutdown' || operation === 'evaluation_workflow' ? null : parseEvaluationCommand({ type: operation, input: command.input }),
        ...(command.type === 'evaluation_workflow' ? { workflowAction: command.input.action } : {}),
        resolve: value => resolve(value as Result<EvaluationWorkerData<K>>), timer });
      child.stdin.write(line, error => { if (!error) return; clearTimeout(timer); this.pending.delete(messageId); resolve(failure('evaluation_write_failed', '评测请求写入结果未知。')); });
    });
  }
  private async read<K extends 'list_evaluation_executions' | 'query_evaluation_result' | 'compare_evaluation' | 'query_evaluation_catalog' | 'query_evaluation_feedback'>(operation: K, input: unknown): Promise<Result<EvaluationWorkerData<K>>> {
    const command = parseEvaluationCommand({ type: operation, input });
    if (!command) return failure('input_invalid', '评测读取请求无效。');
    if (this.closing && !this.child) return failure('evaluation_worker_unavailable', '评测查询通道已关闭。');
    const ready = await this.ensureReady(); if (!ready.ok) return ready;
    return this.request(operation, { input: command.input } as Fields<K>);
  }
  public listExecutions(input: unknown = {}) { return this.read('list_evaluation_executions', input); }
  public result(input: unknown) { return this.read('query_evaluation_result', input); }
  public compare(input: unknown) { return this.read('compare_evaluation', input); }
  public catalog(input: unknown) { return this.read('query_evaluation_catalog', input); }
  public feedback(input: unknown) { return this.read('query_evaluation_feedback', input); }
  public async workflow(input: unknown, agentCredentials?: EvaluationAgentCredential[]): Promise<Result<EvaluationWorkflowResult>> {
    const parsed = EvaluationWorkflowRequestSchema.safeParse(input);
    if (!parsed.success) return failure('input_invalid', '评测闭环请求无效。');
    if (agentCredentials && parsed.data.action !== 'experiment.run') return failure('input_invalid', '只有实验执行可接收私有模型凭据。');
    const readOnly = isWorkflowReadOnly(parsed.data.action);
    if (this.closing || !readOnly && (this.workflowWriting || this.exporting || this.crashBlocked || active(this.current)))
      return failure('evaluation_busy', '评测正在运行、写入、关闭或停止未确认。');
    if (!readOnly) this.workflowWriting = true;
    try {
      const ready = await this.ensureReady(); if (!ready.ok) return ready;
      if (this.closing) return failure('evaluation_busy', '评测正在关闭。');
      registerSecrets(agentCredentials?.map(item => item.apiKey) ?? []);
      const result = await this.request('evaluation_workflow', { input: parsed.data,
        ...(agentCredentials ? { context: { agentCredentials } } : {}) }, readOnly ? 10_000 : null);
      if (result.ok && (result.data.action === 'mine' && result.data.data.operation.stopConfirmed === false
        || result.data.action === 'trace.process' && result.data.data.mining.stopConfirmed === false)) this.crashBlocked = true;
      return result;
    } finally { if (!readOnly) { this.workflowWriting = false; void this.flushCapturedTraces(); } }
  }
  public async addFeedback(input: unknown): Promise<Result<EvaluationWorkerData<'add_evaluation_feedback'>>> {
    const parsed = evaluationRequests.add_evaluation_feedback.safeParse(input);
    if (!parsed.success) return failure('input_invalid', '评测反馈请求无效。');
    if (this.closing || this.workflowWriting || this.exporting || this.crashBlocked || active(this.current)) return failure('evaluation_busy', '评测正在运行、导出、关闭或停止未确认。');
    const ready = await this.ensureReady(); if (!ready.ok) return ready;
    if (this.closing || this.workflowWriting || this.exporting || this.crashBlocked || active(this.current)) return failure('evaluation_busy', '评测状态已变化，请在空闲后提交反馈。');
    return this.request('add_evaluation_feedback', { input: parsed.data });
  }
  public export(input: unknown, prepare?: PrepareExport): Promise<Result<EvaluationWorkerData<'export_evaluation'>>> {
    const parsed = evaluationRequests.export_evaluation.safeParse(input);
    if (!parsed.success) return Promise.resolve(failure('input_invalid', '评测导出请求无效。'));
    const request = parsed.data, prior = this.exports.get(request.operationId);
    if (prior) return prior.executionId === request.executionId ? prior.promise
      : Promise.resolve(failure('evaluation_request_conflict', '原导出操作ID不能改绑其他Execution。'));
    if (this.closing || this.workflowWriting || this.exporting || this.crashBlocked || active(this.current))
      return Promise.resolve(failure('evaluation_busy', '评测正在运行、导出、关闭或停止未确认。'));
    this.exporting = true;
    const work = (async (): Promise<Result<EvaluationWorkerData<'export_evaluation'>>> => {
      try {
        const ready = await this.ensureReady(); if (!ready.ok) return ready;
        if (this.closing || this.crashBlocked || active(this.current)) return failure('evaluation_busy', '评测状态已变化，未发送上传请求。');
        const connection = await (prepare ? prepare() : ok(langfuseConfig(this.evaluationRepository)));
        if (!connection.ok) return connection;
        registerSecrets([connection.data.publicKey, connection.data.secretKey]);
        if (this.closing || this.crashBlocked || active(this.current)) return failure('evaluation_busy', '评测状态已变化，未发送上传请求。');
        return await this.request('export_evaluation', { input: request, connection: connection.data });
      } catch { return failure('evaluation_export_prepare_failed', '平台配置准备失败，未发送上传请求。'); }
    })();
    this.exports.set(request.operationId, { executionId: request.executionId, promise: work });
    void work.finally(() => { this.exporting = false; void this.flushCapturedTraces(); });
    return work;
  }
  public async preview(input: unknown, settings: EvaluationConfigurationSnapshot): Promise<Result<EvaluationPreview>> {
    const parsed = evaluationRequests.preview_evaluation.safeParse(input);
    if (!parsed.success) return failure('input_invalid', '评测选集无效。');
    const ready = await this.ensureReady(); if (!ready.ok) return ready;
    const result = await this.request('preview_evaluation', { input: parsed.data, settings }, 30_000);
    if (result.ok) this.latestPreview = result.data;
    return result;
  }
  public start(input: unknown, prepare: PrepareStart): Promise<Result<EvaluationControlState>> {
    const parsed = evaluationRequests.start_evaluation.safeParse(input);
    if (!parsed.success) return Promise.resolve(failure('input_invalid', '评测启动请求无效。'));
    const prior = this.starts.get(parsed.data.requestId);
    if (prior) return prior.previewId === parsed.data.previewId ? prior.promise : Promise.resolve(failure('evaluation_request_conflict', '原请求不能改绑其他预览。'));
    if (this.closing || this.workflowWriting || this.exporting || this.crashBlocked || active(this.current)) return Promise.resolve(failure('evaluation_busy', '评测正在运行、导出、关闭或停止未确认。'));
    const preview = this.latestPreview;
    if (!preview || preview.previewId !== parsed.data.previewId) return Promise.resolve(failure('evaluation_preview_unknown', '预览已失效，请刷新。'));
    if ([...this.starts.values()].some(start => start.previewId === preview.previewId)) return Promise.resolve(failure('evaluation_preview_consumed', '该预览已受理，请重新预览。'));
    if (!preview.ready) return Promise.resolve(failure('evaluation_not_ready', preview.issues.join('；')));
    const ready = this.ensureReady(), batchId = randomUUID();
    const control: EvaluationControlState = { version: 1, sessionId: this.sessionId, batchId, requestId: parsed.data.requestId, state: 'preparing',
      outcome: null, startedAt: new Date().toISOString(), endedAt: null, executionIds: [], progress: null, stop: 'not-started', errors: [] };
    let resolveStart!: (value: Result<EvaluationControlState>) => void;
    const promise = new Promise<Result<EvaluationControlState>>(done => { resolveStart = done; });
    const start: Start = { previewId: preview.previewId, batchId, control, promise, sent: false, cancelled: false };
    this.starts.set(parsed.data.requestId, start); this.publish(control, true);
    const finish = (outcome: 'failed' | 'cancelled', error?: string) => {
      const ended = { ...start.control, state: 'finished' as const, outcome, endedAt: new Date().toISOString(),
        errors: error ? [...start.control.errors, error] : start.control.errors };
      this.publish(ended); return ok(ended);
    };
    void (async () => {
      try {
        const available = await ready; if (!available.ok) { finish('failed', available.error.message); resolveStart(available); return; }
        if (start.cancelled || this.closing) { resolveStart(finish('cancelled')); return; }
        const prepared = await prepare(structuredClone(preview));
        if (prepared.ok) registerSecrets([prepared.data.credentials.agent, prepared.data.credentials.judge].filter((key): key is string => key !== null));
        if (start.cancelled || this.closing) { resolveStart(finish('cancelled')); return; }
        if (!prepared.ok) { finish('failed', prepared.error.message); resolveStart(prepared); return; }
        start.sent = true;
        const result = await this.request('start_evaluation', { input: parsed.data, context: { ...prepared.data, batchId } });
        if (result.ok) this.publish(result.data);
        else if (['evaluation_response_unknown', 'evaluation_write_failed', 'evaluation_worker_exited', 'evaluation_protocol_invalid'].includes(result.error.code)) this.interrupted();
        else finish('failed', result.error.message);
        resolveStart(result);
      } catch { if (start.sent) this.interrupted(); else finish('failed', '评测配置准备失败。'); resolveStart(failure('evaluation_prepare_failed', '评测准备结果未知，请查询原请求。')); }
    })();
    return promise;
  }
  public async control(input: unknown = {}): Promise<Result<EvaluationControlState>> {
    const parsed = evaluationRequests.query_evaluation_control.safeParse(input);
    if (!parsed.success) return failure('input_invalid', '评测状态查询无效。');
    const record = parsed.data.requestId ? this.starts.get(parsed.data.requestId) : parsed.data.batchId
      ? [...this.starts.values()].find(start => start.batchId === parsed.data.batchId) : this.current?.requestId ? this.starts.get(this.current.requestId) : null;
    const original = !!(parsed.data.requestId || parsed.data.batchId);
    if (record && (!parsed.data.batchId || record.batchId === parsed.data.batchId) && (this.crashBlocked
      || original && (!record.sent || !this.child || !active(record.control) || record.control.sessionId !== this.sessionId)
      || !original && !!this.child && !record.sent && record.control.sessionId === this.sessionId)) return ok(structuredClone(record.control));
    if (this.crashBlocked && this.current && !parsed.data.requestId && !parsed.data.batchId) return ok(structuredClone(this.current));
    const ready = await this.ensureReady(); if (!ready.ok) return ready;
    const result = await this.request('query_evaluation_control', { input: parsed.data });
    if (result.ok) {
      if (record && record.control.sessionId === result.data.sessionId && record.batchId === result.data.batchId) record.control = result.data;
      if (!this.current || this.current.sessionId === result.data.sessionId && this.current.batchId === result.data.batchId
        || !original && !active(this.current) && this.current.stop !== 'pending' && this.current.stop !== 'unconfirmed'
          && this.current.sessionId !== result.data.sessionId) this.current = result.data;
    }
    return result;
  }
  public async cancel(input: unknown): Promise<Result<EvaluationControlState>> {
    const parsed = evaluationRequests.cancel_evaluation.safeParse(input);
    if (!parsed.success) return failure('input_invalid', '评测停止请求无效。');
    const start = [...this.starts.values()].find(record => record.batchId === parsed.data.batchId);
    if (!start) return failure('evaluation_request_unknown', '原评测批次不存在。');
    start.cancelled = true;
    if (!start.sent) {
      if (active(start.control)) this.publish({ ...start.control, state: 'cancelling' });
      return ok(structuredClone(start.control));
    }
    if (!this.child || this.crashBlocked) return ok(structuredClone(start.control));
    const result = await this.request('cancel_evaluation', { input: parsed.data }); if (result.ok) this.publish(result.data); return result;
  }
  public async close(): Promise<Result<{ closed: boolean; stopped: boolean; errors: string[] }>> {
    this.closing = true;
    this.capturedTraces.clear();
    const current = this.current?.requestId ? this.starts.get(this.current.requestId) : null;
    if (current && active(current.control) && !current.sent) {
      current.cancelled = true;
      if (current.control.state !== 'cancelling') this.publish({ ...current.control, state: 'cancelling' });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const prepared = await Promise.race([current.promise.then(() => true), new Promise<false>(done => {
          deadline = setTimeout(() => done(false), CLOSE_TIMEOUT_MS);
        })]);
        if (!prepared) return ok({ closed: false, stopped: !current.sent && !this.crashBlocked, errors: ['评测准备尚未结束，关闭未完成。'] });
      } finally { clearTimeout(deadline); }
    }
    if (!this.child) return ok({ closed: true, stopped: !this.crashBlocked, errors: this.crashBlocked ? ['原评测停止未确认。'] : [] });
    const result = await this.request('shutdown', { input: {} }, CLOSE_TIMEOUT_MS); if (!result.ok) return result;
    if (!result.data.closed || !result.data.stopped || this.crashBlocked) return ok({ closed: result.data.closed, stopped: false, errors: ['原评测停止未确认。'] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = await Promise.race([this.exited.then(() => true), new Promise<false>(done => { timer = setTimeout(() => done(false), 2000); })]);
      return ok({ closed, stopped: true, errors: closed ? [] : ['清理已确认，但评测Worker退出尚未确认。'] });
    } finally { clearTimeout(timer); }
  }
}
