import { appError, fail, normalizeSessionInputRequest, ok, SessionMessagesPageSchema, normalizeAgentRunRequest,
  SetSessionStatusRequestSchema, BranchSessionRequestSchema, WorkspaceContextSchema, normalizeForkSessionRequest, ExtensionCommandReceiptSchema, ExtensionDisposeReceiptSchema, SessionExtensionViewSchema,
  normalizeNativeHistoryPageRequest, normalizeSessionHistoryEntryRequest, SessionInputQuerySchema, SessionInputsRequestSchema } from '@flowmate/contracts';
import { isDeepStrictEqual } from 'node:util';
import type {
  AgentPort,
  CreateSessionRequest,
  DbId,
  DeleteSessionResult,
  NormalizedListSessionsRequest,
  Result,
  RenameSessionRequest,
  RuntimeState,
  SessionAvailability,
  SessionPage,
  SessionSnapshot,
  AgentSessionSnapshot,
  NormalizedSessionMessagesRequest,
  SessionMessagesPage,
  MessageRunInput,
  AgentControl,
  NormalizedAgentRunRequest,
  NormalizedSessionInputRequest,
  RunAccepted,
  SessionInputRequest,
  SessionInputQuery,
  SessionInputQueryResult,
  SessionInputAccepted,
  NormalizedActiveInputRequest,
  SessionInputsRequest,
  SessionInputsPage,
  SetSessionStatusRequest,
  BranchSessionRequest,
  BranchSessionResult,
  NativeHistoryPageRequest, NativeHistoryPage, SessionHistoryEntryRequest, SessionHistoryEntryDetail,
  NativeHistoryWrite, NativeHistoryWriter, HistoryCommitReceipt,
  ForkSessionRequest, ForkSessionResult,
} from '@flowmate/contracts';
import { createHistoryReader } from '../memory/history.ts';
import type { SessionRepository, SessionRow, AgentSessionRow, SessionHistorySnapshot } from '../storage/repositories.ts';
import type { DbHandle, SqlDatabaseStore } from '../storage/database.ts';

export class SessionService {
  private readonly managing = new Set<DbId>();
  private readonly extensionCleanup = new Map<DbId, { instanceId: string; inFlight: boolean }>();

  public constructor(
    private readonly agent: AgentPort,
    private readonly runtimeState: () => RuntimeState,
    private readonly now: () => string,
    private readonly database: Pick<DbHandle, 'read' | 'transaction'>,
    private readonly startInput?: (request: NormalizedAgentRunRequest, submission: NormalizedSessionInputRequest, control?: AgentControl) => Promise<Result<RunAccepted>>,
    private readonly appendInput?: (request: NormalizedActiveInputRequest) => Promise<Result<SessionInputAccepted>>,
    private readonly verifyMutation?: (sessionId: DbId, intent: 'cleanup' | undefined, repository: Pick<SessionRepository, 'isSubagentSession'>) => Result<void>,
  ) {}

  public isManaging(sessionId: DbId): boolean { return this.managing.has(sessionId); }

  private legacySession(repository: SessionRepository, sessionId: DbId): Result<AgentSessionRow> {
    const row = repository.get(sessionId);
    return !row.ok ? row : row.data.runtimeKind === 'agent_session' ? ok(row.data)
      : fail(appError('session_runtime_mismatch', 'session', 'This Session belongs to the Durable business runtime.'));
  }

  private async readQuery<T>(project: (store: SqlDatabaseStore) => Result<T>): Promise<Result<T>> {
    try { return await this.database.read(project); }
    catch { return fail(appError('storage_read_failed', 'storage', 'Saved Session facts could not be read.', true)); }
  }

  private async writeCommand<T>(change: (store: SqlDatabaseStore) => Result<T>): Promise<Result<T>> {
    try { return await this.database.transaction(change); }
    catch { return fail(appError('storage_write_failed', 'storage', 'Session changes could not be saved.', true)); }
  }

  private historyReader(repository: SessionRepository) {
    return createHistoryReader({ repository, agent: this.agent, project: row => this.project(row),
      managementReason: row => {
        const state = this.runtimeState();
        if (this.managing.has(row.sessionId) || state.active && state.active.kind !== 'provider' && state.active.sessionId === row.sessionId) return 'busy';
        const eligibility = this.verifyMutation?.(row.sessionId, undefined, repository);
        if (state.blocked || eligibility && !eligibility.ok || row.status !== 'active' || row.deletePending) return 'session-unavailable';
        try {
          const availability = this.agent.inspect(row.nativeSessionId).availability;
          if (availability === 'busy') return 'busy';
          if (availability === 'unusable') return 'session-unavailable';
        } catch { return 'session-unavailable'; }
        return null;
      } });
  }
  public async listHistory(request: NativeHistoryPageRequest): Promise<Result<NativeHistoryPage>> {
    const parsed = normalizeNativeHistoryPageRequest(request);
    return this.readQuery(scope => {
      if (!parsed.ok) return parsed;
      const owner = this.legacySession(scope.sessions, parsed.data.sessionId);
      return owner.ok ? this.historyReader(scope.sessions).list(parsed.data) : owner;
    });
  }
  public async querySessionHistory(request: NativeHistoryPageRequest): Promise<Result<NativeHistoryPage>> { return this.listHistory(request); }
  public async querySessionHistoryEntry(request: SessionHistoryEntryRequest): Promise<Result<SessionHistoryEntryDetail>> {
    const parsed = normalizeSessionHistoryEntryRequest(request);
    return this.readQuery(scope => {
      if (!parsed.ok) return parsed;
      const owner = this.legacySession(scope.sessions, parsed.data.sessionId);
      return owner.ok ? this.historyReader(scope.sessions).detail(parsed.data) : owner;
    });
  }

  public async submitInput(raw: SessionInputRequest, control?: AgentControl): Promise<Result<SessionInputAccepted>> {
    const normalized = normalizeSessionInputRequest(raw);
    if (!normalized.ok) return normalized;
    let accepted: Result<RunAccepted>;
    const submission = normalized.data;
    if (submission.mode !== 'prompt') {
      if (!this.appendInput) return fail(appError('agent_input_unavailable', 'runtime', 'Active input is unavailable.'));
      accepted = await this.appendInput(submission);
    } else {
      if (!this.startInput) return fail(appError('session_input_unavailable', 'session', 'Session input is unavailable.'));
      const { clientSequence: _sequence, mode: _mode, ...withTarget } = submission;
      const { formTarget: _target, ...request } = withTarget as typeof withTarget & { formTarget?: unknown };
      const runRequest = submission.goalMode === 'fill-form' ? ok(request as NormalizedAgentRunRequest) : normalizeAgentRunRequest(request);
      if (!runRequest.ok) return runRequest;
      accepted = await this.startInput(runRequest.data, submission, control);
    }
    return !accepted.ok ? accepted : accepted.data.inputId === undefined
      ? fail(appError('input_processing_unconfirmed', 'runtime', 'Input admission returned no durable identity.'))
      : ok({ inputId: accepted.data.inputId, sessionId: accepted.data.sessionId, runId: accepted.data.runId });
  }

  public async queryInput(request: SessionInputQuery): Promise<Result<SessionInputQueryResult>> {
    const parsed = SessionInputQuerySchema.safeParse(request);
    return this.readQuery(scope => {
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Session input query is invalid.'));
      const owner = this.legacySession(scope.sessions, parsed.data.sessionId);
      return owner.ok ? scope.sessionInputs.query(parsed.data) : owner;
    });
  }

  public async listInputs(request: SessionInputsRequest): Promise<Result<SessionInputsPage>> {
    const parsed = SessionInputsRequestSchema.safeParse(request);
    return this.readQuery(scope => {
      if (!parsed.success) return fail(appError('input_invalid', 'input', 'Session input page is invalid.'));
      const owner = this.legacySession(scope.sessions, parsed.data.sessionId);
      return owner.ok ? scope.sessionInputs.list(parsed.data) : owner;
    });
  }

  private acquireMutation(repository: SessionRepository, sessionId: DbId, cleanupInstanceId?: string): Result<void> {
    const child = repository.isSubagentSession(sessionId); if (!child.ok) return child;
    if (child.data) return fail(appError('subagent_origin_invalid', 'runtime', 'Child Sessions do not accept public mutations.'));
    const held = this.extensionCleanup.get(sessionId);
    if (this.managing.has(sessionId) && (!cleanupInstanceId || held?.instanceId !== cleanupInstanceId || held.inFlight))
      return fail(appError('session_busy', 'session', 'Session management is in progress.', true));
    const eligible = this.verifyMutation?.(sessionId, cleanupInstanceId ? 'cleanup' : undefined, repository);
    if (eligible && !eligible.ok) return eligible;
    const state = this.runtimeState();
    if (state.blocked && !cleanupInstanceId) return fail(state.error ?? appError('runtime_unusable', 'runtime', 'Runtime is unavailable.', true));
    if (state.active && state.active.kind !== 'provider' && state.active.sessionId === sessionId)
      return fail(appError('session_busy', 'session', 'This Session has an active Run.', true));
    const owner = this.legacySession(repository, sessionId); if (!owner.ok) return owner;
    this.managing.add(sessionId);
    return ok(undefined);
  }

  public async queryExtensions(request: import('@flowmate/contracts').SessionExtensionQuery): Promise<Result<import('@flowmate/contracts').SessionExtensionView>> {
    return this.readQuery(scope => {
      const row = this.legacySession(scope.sessions, request.sessionId); if (!row.ok) return row;
      return this.inspectExtensions(row.data);
    });
  }

  private inspectExtensions(row: SessionRow): Result<import('@flowmate/contracts').SessionExtensionView> {
    if (row.runtimeKind !== 'agent_session') return fail(appError('session_runtime_mismatch', 'session', 'This Session belongs to the Durable business runtime.'));
    const inspected = this.agent.inspectExtensions?.(row.nativeSessionId);
    if (!inspected) return fail(appError('extension_not_loaded', 'extension', 'Extension inspection is unavailable.'));
    if (!inspected.ok) return inspected;
    if (inspected.data.nativeSessionId !== row.nativeSessionId)
      return fail(appError('extension_instance_conflict', 'session', 'Extension owner could not be verified.', true));
    try { return ok(SessionExtensionViewSchema.parse({ ...inspected.data, sessionId: row.sessionId })); }
    catch { return fail(appError('extension_instance_conflict', 'session', 'Extension owner could not be verified.', true)); }
  }

  public async executeExtensionCommand(request: import('@flowmate/contracts').ExtensionCommandRequest): Promise<Result<import('@flowmate/contracts').ExtensionCommandReceipt>> {
    let acquired = false;
    try {
      const row = await this.readQuery(scope => {
        const gate = this.acquireMutation(scope.sessions, request.sessionId); if (!gate.ok) return gate;
        acquired = true;
        return this.legacySession(scope.sessions, request.sessionId);
      });
      if (!row.ok) return row;
      if (row.data.status !== 'active' || row.data.deletePending) return fail(appError('session_archived', 'session', 'Session cannot execute commands.'));
      if (!this.agent.executeExtensionCommand) return fail(appError('extension_not_loaded', 'extension', 'Extension commands are unavailable.'));
      const { sessionId: _sessionId, ...native } = request;
      const result = await this.agent.executeExtensionCommand(row.data.nativeSessionId, native); if (!result.ok) return result;
      if (result.data.nativeSessionId !== row.data.nativeSessionId || result.data.instanceId !== request.expectedInstanceId)
        return fail(appError('extension_instance_conflict', 'session', 'Extension command owner changed.', true));
      const { nativeSessionId: _native, ...receipt } = result.data;
      return ok(ExtensionCommandReceiptSchema.parse({ ...receipt, sessionId: request.sessionId }));
    } catch { return fail(appError('extension_command_failed', 'extension', 'Extension command could not be confirmed.', true)); }
    finally { if (acquired) this.managing.delete(request.sessionId); }
  }

  public async disposeSessionExtensions(request: import('@flowmate/contracts').ExtensionDisposeRequest): Promise<Result<import('@flowmate/contracts').ExtensionDisposeReceipt>> {
    let held: { instanceId: string; inFlight: boolean } | undefined;
    let retainBlocked = true;
    try {
      const prepared = await this.readQuery<{ nativeSessionId: string; receipt: import('@flowmate/contracts').ExtensionDisposeReceipt | null }>(scope => {
        const row = this.legacySession(scope.sessions, request.sessionId); if (!row.ok) return row;
        const inspected = this.inspectExtensions(row.data); if (!inspected.ok) return inspected;
        const instance = inspected.data.instances.find(item => item.instanceId === request.expectedInstanceId);
        if (!instance) return fail(appError(inspected.data.instances.length ? 'extension_instance_conflict' : 'extension_not_loaded', 'extension', 'No matching Extension instance is known.', true));
        if (instance.state === 'disposed') {
          const pending = this.extensionCleanup.get(request.sessionId);
          if (pending?.instanceId === instance.instanceId && !pending.inFlight) {
            this.extensionCleanup.delete(request.sessionId); this.managing.delete(request.sessionId);
          }
          return ok({ nativeSessionId: row.data.nativeSessionId, receipt: ExtensionDisposeReceiptSchema.parse({
            sessionId: request.sessionId, instanceId: instance.instanceId, state: 'disposed', report: { stopped: true, closed: true, errors: [] } }) });
        }
        const gate = this.acquireMutation(scope.sessions, request.sessionId, request.expectedInstanceId); if (!gate.ok) return gate;
        if (!this.agent.disposeExtensions) { this.managing.delete(request.sessionId); return fail(appError('extension_not_loaded', 'extension', 'Extension disposal is unavailable.')); }
        // Reserve retries before leaving this scope, so two queued cleanups cannot both enter.
        held = { instanceId: request.expectedInstanceId, inFlight: true }; this.extensionCleanup.set(request.sessionId, held);
        return ok({ nativeSessionId: row.data.nativeSessionId, receipt: null });
      });
      if (!prepared.ok) return prepared;
      if (prepared.data.receipt) return ok(prepared.data.receipt);
      const result = await this.agent.disposeExtensions!(prepared.data.nativeSessionId, request.expectedInstanceId);
      if (!result.ok) return result;
      if (result.data.nativeSessionId !== prepared.data.nativeSessionId || result.data.instanceId !== request.expectedInstanceId)
        return fail(appError('extension_instance_conflict', 'session', 'Extension cleanup owner changed.', true));
      const { nativeSessionId: _native, ...receipt } = result.data;
      const checked = ExtensionDisposeReceiptSchema.parse({ ...receipt, sessionId: request.sessionId });
      retainBlocked = !checked.report.closed; return ok(checked);
    } catch { return fail(appError('extension_cleanup_failed', 'runtime', 'Extension cleanup could not be confirmed.', true)); }
    finally {
      if (held) {
        held.inFlight = false;
        if (!retainBlocked) { this.extensionCleanup.delete(request.sessionId); this.managing.delete(request.sessionId); }
      }
    }
  }

  public async setStatus(raw: SetSessionStatusRequest): Promise<Result<SessionSnapshot>> {
    const parsed = SetSessionStatusRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'Session status request is invalid.'));
    return this.writeCommand(scope => {
      const acquired = this.acquireMutation(scope.sessions, parsed.data.sessionId);
      if (!acquired.ok) return acquired;
      try {
        const changed = scope.sessions.setStatus({ ...parsed.data, at: this.now() });
        return changed.ok ? ok(this.project(changed.data)) : changed;
      } finally { this.managing.delete(parsed.data.sessionId); }
    });
  }

  public async branch(raw: BranchSessionRequest): Promise<Result<BranchSessionResult>> {
    const parsed = BranchSessionRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(appError('input_invalid', 'input', 'Session branch request is invalid.'));
    const request = parsed.data;
    let acquired = false;
    let retainBlocked = false;
    try {
      const frozen = await this.readQuery(scope => {
        const gate = this.acquireMutation(scope.sessions, request.sessionId); if (!gate.ok) return gate;
        acquired = true;
        return scope.sessions.readHistorySnapshot(request.sessionId, value => ok(value));
      });
      if (!frozen.ok) return frozen;
      const { row, bundle, blocked } = frozen.data;
      if (row.deletePending) return fail(appError('session_delete_incomplete', 'session', 'Retry Delete to finish removing this Session.', true));
      if (row.status !== 'active') return fail(appError('session_archived', 'session', 'Session is archived.'));
      if (blocked) return fail(appError('session_scope_revoked', 'session', 'Material access was revoked.'));
      const { history, commit, seed } = bundle;
      if (!history || !commit || history.unusable || row.historyState !== 'recoverable')
        return fail(appError('session_history_invalid', 'session', 'Saved history is unusable.'));
      if (commit.commitRevision !== request.expectedCommitRevision || commit.entryCount !== request.expectedEntryCount || commit.leafId !== request.expectedLeafId)
        return fail(appError('state_conflict', 'session', 'Saved branch position has changed.', true));
      if (!this.agent.moveSessionLeaf || !this.agent.restoreSessionLeaf || !this.agent.inspectSessionHistory)
        return fail(appError('session_branch_unavailable', 'session', 'Native branch selection is unavailable.'));
      const inspection = this.agent.inspectSessionHistory({ history, seed });
      if (!inspection.ok) return inspection;
      if (inspection.data.positions.find(position => position.entryId === request.targetEntryId)?.contextState !== 'complete')
        return fail(appError('session_branch_unavailable', 'session', 'Select a complete saved native context.'));
      const restored = await ensureNativeSession(this.database, this.agent, row);
      if (!restored.ok) return restored;
      const intended = { history: { ...history, leafId: request.targetEntryId }, seed,
        commit: { ...commit, leafId: request.targetEntryId, commitRevision: commit.commitRevision + (history.leafId === request.targetEntryId ? 0 : 1) } };
      const moved = await this.agent.moveSessionLeaf(row.nativeSessionId, request.targetEntryId);
      let failure = moved.ok ? appError('storage_write_failed', 'storage', 'Branch selection could not be saved.', true) : moved.error;
      if (moved.ok && sameJson(moved.data, intended.history)) {
        const saved = await this.writeCommand(scope => scope.memory.commit({ sessionId: request.sessionId, expected: commit, header: history.header,
          appendEntries: [], contexts: [], leafId: request.targetEntryId, unusable: history.unusable }));
        if (!saved.ok) failure = saved.error;
      }
      // Read back once after an uncertain receipt; never repeat the leaf mutation or CAS.
      const readback = await this.readQuery(scope => scope.sessions.readHistorySnapshot(request.sessionId, value => ok(value)));
      const latest = readback.ok ? ok(readback.data.bundle) : readback;
      const unchangedAssociations = readback.ok && sameJson(readback.data.associations, frozen.data.associations) && !readback.data.blocked;
      const targetConfirmed = latest.ok && unchangedAssociations && sameJson(latest.data, intended);
      const oldConfirmed = latest.ok && unchangedAssociations && sameJson(latest.data, bundle);
      if (!latest.ok || !targetConfirmed && !oldConfirmed || !latest.data.history || !latest.data.commit) {
        retainBlocked = true;
        const sticky = await this.writeCommand(scope => scope.sessions.markHistoryUnusable(request.sessionId));
        try { await this.agent.releaseSession(row.nativeSessionId); } catch { /* The management gate remains closed. */ }
        return !sticky.ok ? sticky : !latest.ok ? latest : fail(appError('session_history_invalid', 'session', 'Committed branch position cannot be confirmed.', true));
      }
      const confirmed = this.agent.restoreSessionLeaf(row.nativeSessionId, latest.data.history, latest.data.seed, latest.data.commit);
      if (!confirmed.ok) {
        retainBlocked = true;
        const sticky = await this.writeCommand(scope => scope.sessions.markHistoryUnusable(request.sessionId));
        try { await this.agent.releaseSession(row.nativeSessionId); } catch { /* Preserve the management gate. */ }
        return !sticky.ok ? sticky : confirmed;
      }
      if (targetConfirmed && moved.ok)
        return ok({ session: this.project(row), leafId: request.targetEntryId, entryCount: history.entries.length });
      return fail(failure);
    } finally { if (acquired && !retainBlocked) this.managing.delete(request.sessionId); }
  }

  public async forkSession(raw: ForkSessionRequest): Promise<Result<ForkSessionResult>> {
    const parsed = normalizeForkSessionRequest(raw);
    if (!parsed.ok) return parsed;
    const request = parsed.data;
    // A committed intent precedes the NEW-source management gate and stale source CAS.
    const existing = await this.readQuery(scope => scope.sessions.findFork(request));
    if (!existing.ok) return existing;
    if (existing.data !== null) return this.restoreFork(existing.data, request);
    let acquired = false;
    try {
      const qualify = ({ row, bundle, blocked }: SessionHistorySnapshot, repository: SessionRepository): Result<void> => {
        const state = this.runtimeState();
        if (state.blocked) return fail(state.error ?? appError('runtime_unusable', 'runtime', 'Runtime is unavailable.', true));
        if (state.active && state.active.kind !== 'provider' && state.active.sessionId === row.sessionId)
          return fail(appError('session_busy', 'session', 'This Session has an active Run.', true));
        if (row.deletePending) return fail(appError('session_delete_incomplete', 'session', 'Retry Delete to finish removing this Session.', true));
        if (row.status !== 'active') return fail(appError('session_archived', 'session', 'Session is archived.'));
        if (blocked) return fail(appError('session_scope_revoked', 'session', 'Material access was revoked.'));
        if (!bundle.history || !bundle.commit || bundle.history.unusable || row.historyState !== 'recoverable')
          return fail(appError('session_history_invalid', 'session', 'Saved history is unusable.'));
        if (!sameJson(bundle.commit, request.expected)) return fail(appError('state_conflict', 'session', 'Fork source position has changed.', true));
        const eligibility = this.verifyMutation?.(row.sessionId, undefined, repository); if (eligibility && !eligibility.ok) return eligibility;
        const availability = this.agent.inspect(row.nativeSessionId).availability;
        if (availability === 'busy') return fail(appError('session_busy', 'session', 'Native Session is active.', true));
        if (availability === 'unusable') return fail(appError('agent_session_unusable', 'session', 'Native Session is unusable.'));
        if (!this.agent.inspectSessionHistory || !this.agent.buildForkSessionHistory)
          return fail(appError('session_branch_unavailable', 'session', 'Native fork is unavailable.'));
        const inspected = this.agent.inspectSessionHistory({ history: bundle.history, seed: bundle.seed });
        if (!inspected.ok) return inspected;
        return inspected.data.positions.find(position => position.entryId === request.targetEntryId)?.contextState === 'complete'
          ? ok(undefined) : fail(appError('session_branch_unavailable', 'session', 'Select a complete saved native context.'));
      };
      const frozen = await this.readQuery(scope => {
        const gate = this.acquireMutation(scope.sessions, request.sourceSessionId); if (!gate.ok) return gate;
        acquired = true;
        return scope.sessions.readHistorySnapshot(request.sourceSessionId, value => {
          const qualified = qualify(value, scope.sessions); return qualified.ok ? ok(value) : qualified;
        });
      });
      if (!frozen.ok) return frozen;
      // Keep the frozen source proof independent of the adapter's detached construction.
      const built = this.agent.buildForkSessionHistory!({ source: structuredClone(frozen.data.bundle.history!), targetEntryId: request.targetEntryId });
      if (!built.ok) return built;
      const created = await this.writeCommand(scope => scope.sessions.createFork({ request, history: built.data, frozen: frozen.data,
        qualify: snapshot => qualify(snapshot, scope.sessions), at: this.now() }));
      return created.ok ? await this.restoreFork(created.data, request) : created;
    } catch { return fail(appError('session_history_unavailable', 'session', 'Fork history could not be assembled.', true)); }
    finally { if (acquired) this.managing.delete(request.sourceSessionId); }
  }

  private async restoreFork(target: DbId, request: ForkSessionRequest): Promise<Result<ForkSessionResult>> {
    const current = await this.readQuery(scope => scope.sessions.readHistorySnapshot(target, value => value.blocked
      ? fail(appError('session_scope_revoked', 'session', 'Material access was revoked.')) : ok(value)));
    if (!current.ok) return current;
    if (!current.data.bundle.commit) return fail(appError('session_history_unavailable', 'session', 'Fork history is unavailable.'));
    const row = current.data.row;
    try {
      const restored = await installNativeSession(this.database, this.agent, row);
      if (!restored.ok) {
        // A failed cache installation does not invalidate the committed collection.
        if (restored.error.code !== 'session_busy') try { await this.agent.releaseSession(row.nativeSessionId); } catch { /* Preserve durable target. */ }
        return restored;
      }
      return ok({ session: this.project(restored.data.row), commit: restored.data.commit,
        sourceSessionId: request.sourceSessionId, selectedEntryId: request.targetEntryId });
    } catch {
      try { await this.agent.releaseSession(row.nativeSessionId); } catch { /* Preserve durable target. */ }
      return fail(appError('session_history_unavailable', 'session', 'The committed fork could not be installed. Retry the same operation.', true));
    }
  }

  public async create(request: CreateSessionRequest): Promise<Result<AgentSessionSnapshot>> {
    let createdNativeId: string | null = null;
    let hasHistory = false;
    const row = await this.writeCommand(scope => {
      const native = this.agent.createSession(); if (!native.ok) return native;
      createdNativeId = native.data.nativeSessionId;
      const history = this.agent.exportSession?.(createdNativeId); if (history && !history.ok) return history;
      hasHistory = Boolean(history);
      return scope.sessions.create({ nativeSessionId: createdNativeId, title: request.title ?? 'New Session',
        at: this.now(), ...(history?.ok ? { nativeHistory: history.data } : {}),
        ...(request.expectedRevision === undefined ? {} : { expectedRevision: request.expectedRevision }) });
    });
    if (!row.ok) {
      if (createdNativeId !== null) try { await this.agent.releaseSession(createdNativeId); } catch { /* preserve the failed DB insert */ }
      return row;
    }
    // Older ports can still create a browse-only product identity; no durable
    // Header means they cannot advertise native readiness or admit a new Run.
    if (!hasHistory) return ok(this.project(row.data));
    const watched = await ensureNativeSession(this.database, this.agent, row.data);
    if (!watched.ok) {
      await this.agent.releaseSession(row.data.nativeSessionId);
      return watched;
    }
    return ok(this.project(row.data));
  }

  public async get(sessionId: DbId): Promise<Result<AgentSessionSnapshot>> {
    return this.readQuery(scope => {
    const row = this.legacySession(scope.sessions, sessionId);
    if (!row.ok) return row;
    return ok(this.project(row.data));
    });
  }

  public async rename(request: RenameSessionRequest): Promise<Result<SessionSnapshot>> {
    return this.writeCommand(scope => {
      if (this.managing.has(request.sessionId)) return deleteInProgress();
      const row = scope.sessions.rename({ sessionId: request.sessionId, title: request.title, at: this.now() });
      return row.ok ? ok(this.project(row.data)) : row;
    });
  }

  public async deleteSession(sessionId: DbId): Promise<Result<DeleteSessionResult>> {
    let acquired = false;
    try {
      const prepared = await this.writeCommand(scope => {
        const gate = this.acquireMutation(scope.sessions, sessionId); if (!gate.ok) return gate;
        acquired = true;
        return scope.sessions.prepareDelete(sessionId, this.now());
      });
      if (!prepared.ok) return prepared;
      if (prepared.data.runtimeKind !== 'agent_session') return fail(appError('session_runtime_mismatch', 'session', 'This Session belongs to the Durable business runtime.'));
      let released;
      try { released = await this.agent.releaseSession(prepared.data.nativeSessionId); }
      catch { return failDeleteSession(); }
      if (!released.stopped || !released.closed) return failDeleteSession();
      const deleted = await this.writeCommand(scope => scope.sessions.delete(sessionId, this.now()));
      return deleted.ok ? ok({ deletedSessionId: sessionId, disposition: deleted.data }) : failDeleteSession();
    } finally {
      if (acquired) this.managing.delete(sessionId);
    }
  }

  public async list(request: NormalizedListSessionsRequest): Promise<Result<SessionPage>> {
    return this.readQuery(scope => {
    const page = scope.sessions.list(request);
    if (!page.ok) return page;
    return ok({
      items: page.data.items.map((row) => this.project(row)),
      next: page.data.next,
    });
    });
  }

  public async listMessages(request: NormalizedSessionMessagesRequest): Promise<Result<SessionMessagesPage>> {
    return this.readQuery(scope => {
    const row = this.legacySession(scope.sessions, request.sessionId);
    if (!row.ok) return row;
    const stored = scope.sessions.readHistoryForDisplay(request.sessionId);
    if (!stored.ok) return stored;
    if (!stored.data.history && row.data.historyState === 'legacy-read-only') {
      return ok({ session: this.project(row.data), leafId: null, entryCount: 0, items: [], nextBeforeEntryId: null });
    }
    if (!stored.data.history || !this.agent.projectSessionMessages) {
      return fail(appError('session_history_unavailable', 'session', 'Saved native messages are unavailable.'));
    }
    const runInputs: MessageRunInput[] = [];
    for (const runId of new Set(stored.data.bindings.map((binding) => binding.runId))) {
      const run = scope.runs.get(runId);
      if (!run.ok || run.data.kind === 'provider' || !stored.data.origins.filter(origin => origin.originRunId === runId).every(origin => origin.originSessionId === run.data.sessionId)) {
        return fail(appError('session_history_invalid', 'session', 'Saved message Run identity is inconsistent.'));
      }
      const config = run.data.config as Record<string, unknown>;
      const mode = config.goalMode;
      const goalMode = mode === 'answer' || mode === 'save-candidate' || mode === 'fill-form' ? mode : null;
      if (run.data.input.version === 2 && goalMode === null) {
        return fail(appError('session_history_invalid', 'session', 'Saved message Run context is incomplete.'));
      }
      const context = config.workspaceContext === undefined ? undefined : WorkspaceContextSchema.safeParse(config.workspaceContext);
      if (context && !context.success)
        return fail(appError('session_history_invalid', 'session', 'Saved message Workspace context is invalid.'));
      runInputs.push({ runId, input: run.data.input, goalMode,
        ...(context?.success ? { workspaceContext: context.data } : {}),
        ...(typeof config.workingDirectory === 'string' ? { workingDirectory: config.workingDirectory } : {}) });
    }
    const projected = this.agent.projectSessionMessages({ history: stored.data.history, bindings: stored.data.bindings,
      runInputs, sessionInputs: stored.data.sessionInputs, limit: request.limit, ...(request.beforeEntryId === undefined ? {} : { beforeEntryId: request.beforeEntryId }) });
    if (!projected.ok) return projected;
    const page = { session: this.project(row.data), leafId: stored.data.history.leafId,
      entryCount: stored.data.history.entries.length, ...projected.data };
    const parsed = SessionMessagesPageSchema.safeParse(page);
    return parsed.success ? ok(parsed.data) : fail(appError('session_history_invalid', 'session', 'Saved message projection is invalid.'));
    });
  }

  private project(row: AgentSessionRow): AgentSessionSnapshot;
  private project(row: SessionRow): SessionSnapshot;
  private project(row: SessionRow): SessionSnapshot {
    if (row.runtimeKind === 'durable') return { runtimeKind: 'durable', nativeSessionId: null, sessionId: row.sessionId,
      title: row.title, status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt,
      availability: row.status === 'archived' ? 'archived' : 'history-unavailable', historyState: row.historyState,
      activeRunId: null, modelUseBlocked: row.modelUseBlocked, hasBusinessHistory: row.hasBusinessHistory, deletePending: row.deletePending };
    const activeRun = this.runtimeState().active;
    const activeRunId = activeRun?.kind === 'agent' && activeRun.sessionId === row.sessionId ? activeRun.runId : null;
    const activeOperation = activeRun && activeRun.kind !== 'provider' && activeRun.sessionId === row.sessionId;
    let availability: SessionAvailability;
    if (row.status === 'archived') availability = 'archived';
    else {
      try {
        const inspected = this.agent.inspect(row.nativeSessionId);
        availability = row.nativeUnusable ? 'unusable'
          : row.historyState !== 'recoverable' ? 'history-unavailable'
          : activeOperation || inspected.availability === 'busy' ? 'busy'
          : inspected.availability === 'ready' ? 'ready'
            : inspected.availability === 'unusable' ? 'unusable'
              : row.historyState === 'recoverable' ? 'ready' : 'history-unavailable';
      } catch {
        availability = 'history-unavailable';
      }
    }
    return {
      runtimeKind: 'agent_session', sessionId: row.sessionId,
      nativeSessionId: row.nativeSessionId,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      availability,
      historyState: row.historyState,
      activeRunId,
      modelUseBlocked: row.modelUseBlocked,
      hasBusinessHistory: row.hasBusinessHistory,
      deletePending: row.deletePending,
    };
  }
}

export async function ensureNativeSession(database: Pick<DbHandle, 'read' | 'transaction'>, agent: AgentPort, row: SessionRow): Promise<Result<void>> {
  const installed = await installNativeSession(database, agent, row);
  return installed.ok ? ok(undefined) : installed;
}

export async function installNativeSession(database: Pick<DbHandle, 'read' | 'transaction'>, agent: AgentPort,
  row: SessionRow): Promise<Result<{ row: AgentSessionRow; commit: HistoryCommitReceipt }>> {
  const save: NativeHistoryWriter = async write => {
    try {
      const frozen = structuredClone(write);
      return await commitNativeWrite(database, row.sessionId, frozen);
    } catch { return fail(appError('storage_write_failed', 'storage', 'Conversation history could not be saved.', true)); }
  };
  try { return await database.read(scope => installNativeSnapshot(scope.sessions, agent, row, save)); }
  catch { return fail(appError('storage_read_failed', 'storage', 'Conversation history could not be read.', true)); }
}

/** The returned row and receipt are from the exact authorized snapshot installed below. */
function installNativeSnapshot(repository: SessionRepository, agent: AgentPort, row: SessionRow,
  save: NativeHistoryWriter): Result<{ row: AgentSessionRow; commit: HistoryCommitReceipt }> {
  if (row.runtimeKind !== 'agent_session') return fail(appError('session_runtime_mismatch', 'session', 'This Session belongs to the Durable business runtime.'));
  if (row.nativeUnusable) return fail(appError('agent_session_unusable', 'session', 'This conversation cannot continue after an interrupted request.'));
  let availability: ReturnType<AgentPort['inspect']>['availability'];
  try {
    availability = agent.inspect(row.nativeSessionId).availability;
  } catch { return fail(appError('agent_session_unavailable', 'session', 'Conversation state is unavailable.')); }
  if (availability === 'busy') return fail(appError('session_busy', 'session', 'Native Session is active.', true));
  if (availability === 'unusable') return fail(appError('agent_session_unusable', 'session', 'Native Session is unusable.'));
  if (availability === 'missing' && (row.historyState !== 'recoverable' || !agent.restoreSession || !agent.watchSession)) {
    return fail(appError(row.historyState === 'invalid' ? 'session_history_invalid' : 'session_history_unavailable',
      'session', 'This conversation cannot be restored. Start a new chat.'));
  }
  const current = repository.readHistorySnapshot(row.sessionId, value => value.blocked
    ? fail(appError('session_scope_revoked', 'session', 'Material access was revoked.')) : ok(value));
  if (!current.ok) return current;
  const { row: installedRow, bundle } = current.data;
  if (installedRow.nativeUnusable) return fail(appError('agent_session_unusable', 'session', 'This conversation cannot continue after an interrupted request.'));
  if (!bundle.history || !bundle.commit || !agent.watchSession)
    return fail(appError('session_history_unavailable', 'session', 'This conversation has no saved native history.'));
  const restore = availability === 'ready' ? agent.restoreSessionLeaf : agent.restoreSession;
  if (!restore) return fail(appError('context_binding_unknown', 'runtime', 'Saved conversation sources cannot be reconnected.'));
  const restored = restore.call(agent, installedRow.nativeSessionId, bundle.history, bundle.seed, bundle.commit);
  if (!restored.ok) return restored;
  const watched = agent.watchSession(installedRow.nativeSessionId, bundle.commit, bundle.seed, save);
  return watched.ok ? ok({ row: installedRow, commit: bundle.commit }) : watched;
}

function sameJson(a: unknown, b: unknown): boolean { return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b))); }
async function commitNativeWrite(database: Pick<DbHandle, 'read' | 'transaction'>, sessionId: DbId,
  write: NativeHistoryWrite): Promise<Result<HistoryCommitReceipt>> {
  const writeInputIds = [...new Set(write.contexts.flatMap(context => [
    ...(context.inputId === undefined ? [] : [context.inputId]), ...(context.resultInputIds ?? [])]))];
  const before = await database.read(scope => scope.sessions.readHistorySnapshot(sessionId, value => ok(value), writeInputIds));
  if (!before.ok) return before;
  const frozen = before.data;
  if (!frozen.bundle.history || !sameJson(frozen.bundle.commit, write.expected))
    return fail(appError('state_conflict', 'session', 'Conversation history has changed.', true));
  const changed = !sameJson(frozen.bundle.history, write.history);
  const intended = { commitRevision: write.expected.commitRevision + (changed ? 1 : 0), entryCount: write.history.entries.length, leafId: write.history.leafId };
  const contexts = new Map(write.contexts.map(context => [context.entryId, context]));
  const oldEntries = new Map(frozen.associations.entries.map(entry => [entry.entry_id, entry]));
  // Freeze the exact association effects declared by this write, before invoking SQL.
  const associations = { entries: write.history.entries.map(entry => oldEntries.get(entry.id)
      ?? { entry_id: entry.id, run_id: contexts.get(entry.id)?.runId ?? null }),
    inputs: structuredClone(frozen.associations.inputs) };
  for (const entry of write.history.entries) {
    const context = contexts.get(entry.id); if (!context) continue;
    for (const input of associations.inputs) {
      if (input.id === context.inputId && input.status !== 'consumed') {
        input.status = 'consumed'; input.native_entry_id = entry.id; input.updated_at = entry.timestamp;
      }
      if (context.resultInputIds?.includes(input.id as number) && input.result_entry_id === null) {
        input.result_entry_id = entry.id; input.updated_at = entry.timestamp;
      }
    }
  }
  let saved: Result<HistoryCommitReceipt>;
  try { saved = await database.transaction(scope => scope.memory.commit({ sessionId, expected: write.expected, header: write.history.header, appendEntries: write.history.entries,
    leafId: write.history.leafId, unusable: write.history.unusable, contexts: write.contexts })); }
  catch { saved = fail(appError('storage_write_failed', 'storage', 'Conversation history could not be saved.', true)); }
  if (saved.ok && sameJson(saved.data, intended)) return saved;
  const loaded = await database.read(scope => scope.sessions.readHistorySnapshot(sessionId, value => ok(value), writeInputIds));
  if (loaded.ok && sameJson(loaded.data.bundle.history, write.history) && sameJson(loaded.data.bundle.commit, intended)
    && sameJson(loaded.data.associations, associations)) {
    const seed = loaded.data.bundle.seed;
    const origins = new Map(seed.origins.map(origin => [origin.nativeEntryId, origin]));
    const originalSourcesMatch = frozen.bundle.seed.origins.every(origin => sameJson(origin, origins.get(origin.nativeEntryId)))
      && frozen.bundle.seed.inputs.every(input => sameJson(input, seed.inputs.find(item => item.nativeEntryId === input.nativeEntryId)));
    const appendedSourcesMatch = write.history.entries.slice(write.expected.entryCount).every(entry => {
      const context = contexts.get(entry.id); const origin = origins.get(entry.id);
      return origin?.originSessionId === sessionId && origin.originRunId === (context?.runId ?? null);
    });
    if (originalSourcesMatch && appendedSourcesMatch) return ok(intended);
  }
  const blocked = await database.transaction(scope => scope.sessions.markHistoryUnusable(sessionId));
  if (!blocked.ok) return blocked;
  return !saved.ok ? saved : fail(appError('storage_write_failed', 'storage', 'Conversation history receipt could not be confirmed.', true));
}

function deleteInProgress<T>(): Result<T> {
  return fail(appError('session_delete_in_progress', 'session', 'A Session deletion is already in progress.', true));
}

function failDeleteSession(): Result<DeleteSessionResult> {
  return { ok: false, error: { code: 'session_delete_incomplete', category: 'session', message: 'Session deletion is incomplete. Retry Delete Session to finish removing it.', retryable: true } };
}
