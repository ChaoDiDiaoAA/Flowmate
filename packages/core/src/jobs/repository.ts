import { randomUUID } from "node:crypto";
import { AssetRefSchema, InvoiceCandidateSchema, RuntimeEventSchema, type AssetRef, type InvoiceCandidate, type RunIdentity, type RunStatus, type CleanupStatus, type RuntimeEvent } from "@flowmate/contracts";
import type { SqliteDatabase } from "../storage/database.js";
import { insertArtifact, selectArtifact } from "../storage/artifacts.js";

export type JobStatus = "created" | "running" | "cancelling" | "candidate_ready" | "failed" | "cancelled" | "interrupted";
export type JobInput = { id?: string; jobType: string; sampleId: string; inputHash: string; candidateId: string };
export type Job = JobInput & { id: string; generation: number; currentRunId: string | null; status: JobStatus; cancelRequested: boolean; createdAt: string; updatedAt: string };
export type AgentRun = { runId: string; jobId: string; candidateId: string; generation: number; sessionId: string | null; status: RunStatus; cleanupStatus: CleanupStatus; cancelReason: string | null; startedAt: string; finishedAt: string | null };
export type CandidateRecord = { id: string; jobId: string; runId: string; requestId: string; rawRef: AssetRef; candidate: InvoiceCandidate; createdAt: string };
export type JobSnapshot = { job: Job; runs: AgentRun[]; candidates: CandidateRecord[] };
export type ToolCallRecord = { callId: string; runId: string; requestId: string; requestHash: string; toolName: string; toolVersion: string; status: string; requestAssetId: string | null; resultAssetId: string | null; at: string };

type CandidateRow = { id: string; job_id: string; run_id: string; request_id: string; raw_asset_id: string; candidate_json: string; created_at: string };
type JobRow = { id: string; job_type: string; sample_id: string; input_hash: string; candidate_id: string; generation: number; current_run_id: string | null; status: JobStatus; cancel_requested: number; created_at: string; updated_at: string };
type RunRow = { run_id: string; job_id: string; candidate_id: string; generation: number; session_id: string | null; status: RunStatus; cleanup_status: CleanupStatus; cancel_reason: string | null; started_at: string; finished_at: string | null };

export type Store = {
  createJob(input: JobInput): Job;
  startRun(jobId: string, candidateId: string): AgentRun;
  acceptCandidate(identity: RunIdentity, requestId: string, rawRef: AssetRef, candidate: InvoiceCandidate): CandidateRecord;
  attachSession(identity: RunIdentity, sessionId: string): AgentRun;
  requestCancel(runId: string, reason?: string): AgentRun;
  finishRun(runId: string, outcome: RunStatus, cleanup: CleanupStatus): AgentRun;
  getJob(jobId: string): JobSnapshot;
  recordRuntimeEvent(event: RuntimeEvent): RuntimeEvent;
  getRuntimeEvents(runId: string): RuntimeEvent[];
  recordToolCall(call: Omit<ToolCallRecord, "callId" | "at"> & { callId?: string; at?: string }): ToolCallRecord;
  getToolCalls(runId: string): ToolCallRecord[];
  putArtifact(runId: string, kind: string, bytes: Uint8Array): Promise<AssetRef>;
  getArtifact(assetId: string): { ref: AssetRef; bytes: Buffer };
  close(): void;
};

function now(): string { return new Date().toISOString(); }
function transaction<T>(db: SqliteDatabase, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE;");
  try {
    const value = fn();
    db.exec("COMMIT;");
    return value;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
function mapJob(row: JobRow): Job {
  return { id: row.id, jobType: row.job_type, sampleId: row.sample_id, inputHash: row.input_hash, candidateId: row.candidate_id, generation: row.generation, currentRunId: row.current_run_id, status: row.status, cancelRequested: row.cancel_requested === 1, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapRun(row: RunRow): AgentRun {
  return { runId: row.run_id, jobId: row.job_id, candidateId: row.candidate_id, generation: row.generation, sessionId: row.session_id, status: row.status, cleanupStatus: row.cleanup_status, cancelReason: row.cancel_reason, startedAt: row.started_at, finishedAt: row.finished_at };
}
function getJobRow(db: SqliteDatabase, id: string): JobRow {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  if (!row) throw new Error("JOB_NOT_FOUND");
  return row;
}
function getRunRow(db: SqliteDatabase, id: string): RunRow {
  const row = db.prepare("SELECT * FROM agent_runs WHERE run_id = ?").get(id) as RunRow | undefined;
  if (!row) throw new Error("RUN_NOT_FOUND");
  return row;
}
function mapCandidate(db: SqliteDatabase, row: CandidateRow): CandidateRecord {
  const raw = selectArtifact(db, row.raw_asset_id);
  const parsed = InvoiceCandidateSchema.parse(JSON.parse(row.candidate_json));
  return { id: row.id, jobId: row.job_id, runId: row.run_id, requestId: row.request_id, rawRef: raw.ref, candidate: parsed, createdAt: row.created_at };
}

export function createStore(db: SqliteDatabase): Store {
  return {
    createJob(input) {
      const id = input.id ?? `job-${randomUUID()}`;
      const timestamp = now();
      db.prepare("INSERT INTO jobs (id, job_type, sample_id, input_hash, candidate_id, generation, current_run_id, status, cancel_requested, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, NULL, 'created', 0, ?, ?)").run(id, input.jobType, input.sampleId, input.inputHash, input.candidateId, timestamp, timestamp);
      return mapJob(getJobRow(db, id));
    },

    startRun(jobId, candidateId) {
      return transaction(db, () => {
        const job = getJobRow(db, jobId);
        if (job.candidate_id !== candidateId) throw new Error("CANDIDATE_MISMATCH");
        if (job.current_run_id) {
          const active = db.prepare("SELECT status FROM agent_runs WHERE run_id = ?").get(job.current_run_id) as { status?: string } | undefined;
          if (active && ["created", "running", "cancelling"].includes(active.status ?? "")) throw new Error("RUN_ALREADY_ACTIVE");
        }
        const generation = job.generation + 1;
        const runId = `run-${randomUUID()}`;
        const timestamp = now();
        db.prepare("INSERT INTO agent_runs (run_id, job_id, candidate_id, generation, session_id, status, cleanup_status, cancel_reason, started_at, finished_at) VALUES (?, ?, ?, ?, NULL, 'running', 'pending', NULL, ?, NULL)").run(runId, jobId, candidateId, generation, timestamp);
        db.prepare("UPDATE jobs SET generation = ?, current_run_id = ?, status = 'running', cancel_requested = 0, updated_at = ? WHERE id = ?").run(generation, runId, timestamp, jobId);
        return mapRun(getRunRow(db, runId));
      });
    },

    acceptCandidate(identity, requestId, rawRef, candidate) {
      const parsedCandidate = InvoiceCandidateSchema.parse(candidate);
      AssetRefSchema.parse(rawRef);
      return transaction(db, () => {
        const run = getRunRow(db, identity.runId);
        const job = getJobRow(db, identity.jobId);
        if (run.job_id !== identity.jobId || run.generation !== identity.generation || run.candidate_id !== identity.candidateId || job.current_run_id !== identity.runId || job.generation !== identity.generation) throw new Error("STALE_RUN");
        if (job.cancel_requested === 1 || ["cancelling", "cancelled", "interrupted"].includes(run.status)) throw new Error("RUN_CANCELLED");
        if (parsedCandidate.sampleId !== job.sample_id) throw new Error("SAMPLE_MISMATCH");
        const raw = db.prepare("SELECT asset_id, run_id FROM artifacts WHERE asset_id = ?").get(rawRef.assetId) as { asset_id: string; run_id: string } | undefined;
        if (!raw || raw.run_id !== identity.runId) throw new Error("RAW_ARTIFACT_NOT_FOUND");
        const existing = db.prepare("SELECT * FROM invoice_candidates WHERE run_id = ? AND request_id = ?").get(identity.runId, requestId) as CandidateRow | undefined;
        const candidateJson = JSON.stringify(parsedCandidate);
        if (existing) {
          if (existing.candidate_json === candidateJson && existing.raw_asset_id === rawRef.assetId) return mapCandidate(db, existing);
          throw new Error("REQUEST_CONFLICT");
        }
        const id = `candidate-${randomUUID()}`;
        const timestamp = now();
        db.prepare("INSERT INTO invoice_candidates (id, job_id, run_id, request_id, raw_asset_id, candidate_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, identity.jobId, identity.runId, requestId, rawRef.assetId, candidateJson, timestamp);
        db.prepare("UPDATE jobs SET status = 'candidate_ready', updated_at = ? WHERE id = ?").run(timestamp, identity.jobId);
        return mapCandidate(db, { id, job_id: identity.jobId, run_id: identity.runId, request_id: requestId, raw_asset_id: rawRef.assetId, candidate_json: candidateJson, created_at: timestamp });
      });
    },

    attachSession(identity, sessionId) {
      if (!sessionId.trim()) throw new Error("SESSION_ID_REQUIRED");
      return transaction(db, () => {
        const run = getRunRow(db, identity.runId);
        const job = getJobRow(db, identity.jobId);
        if (run.job_id !== identity.jobId || run.generation !== identity.generation || run.candidate_id !== identity.candidateId || job.current_run_id !== identity.runId) throw new Error("STALE_RUN");
        db.prepare("UPDATE agent_runs SET session_id = ? WHERE run_id = ?").run(sessionId, identity.runId);
        return mapRun(getRunRow(db, identity.runId));
      });
    },

    requestCancel(runId, reason = "requested") {
      return transaction(db, () => {
        const run = getRunRow(db, runId);
        const timestamp = now();
        if (["created", "running", "cancelling"].includes(run.status)) {
          db.prepare("UPDATE agent_runs SET status = 'cancelling', cancel_reason = ? WHERE run_id = ?").run(reason, runId);
          db.prepare("UPDATE jobs SET status = 'cancelling', cancel_requested = 1, updated_at = ? WHERE id = ?").run(timestamp, run.job_id);
        }
        return mapRun(getRunRow(db, runId));
      });
    },

    finishRun(runId, outcome, cleanup) {
      return transaction(db, () => {
        const run = getRunRow(db, runId);
        const timestamp = now();
        db.prepare("UPDATE agent_runs SET status = ?, cleanup_status = ?, finished_at = ? WHERE run_id = ?").run(outcome, cleanup, timestamp, runId);
        const candidate = db.prepare("SELECT 1 FROM invoice_candidates WHERE run_id = ? LIMIT 1").get(runId);
        const jobStatus: JobStatus = candidate ? "candidate_ready" : outcome === "cancelled" ? "cancelled" : outcome === "interrupted" ? "interrupted" : outcome === "succeeded" ? "failed" : "failed";
        db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status <> 'candidate_ready'").run(jobStatus, timestamp, run.job_id);
        return mapRun(getRunRow(db, runId));
      });
    },

    getJob(jobId) {
      const job = mapJob(getJobRow(db, jobId));
      const runs = (db.prepare("SELECT * FROM agent_runs WHERE job_id = ? ORDER BY generation").all(jobId) as RunRow[]).map(mapRun);
      const candidates = (db.prepare("SELECT * FROM invoice_candidates WHERE job_id = ? ORDER BY created_at").all(jobId) as CandidateRow[]).map((row) => mapCandidate(db, row));
      return { job, runs, candidates };
    },

    recordRuntimeEvent(event) {
      const parsed = RuntimeEventSchema.parse(event);
      transaction(db, () => {
        const run = getRunRow(db, parsed.runId);
        const job = getJobRow(db, parsed.jobId);
        if (run.job_id !== parsed.jobId || run.generation !== parsed.generation || run.candidate_id !== parsed.candidateId || job.current_run_id !== parsed.runId) throw new Error("STALE_RUN");
        const existing = db.prepare("SELECT event_id, run_id, seq, event_type, session_id, delegation_id, payload_asset_id, at FROM runtime_events WHERE event_id = ? OR (run_id = ? AND seq = ?)").get(parsed.eventId, parsed.runId, parsed.seq) as {
          event_id?: string;
          run_id?: string;
          seq?: number;
          event_type?: string;
          session_id?: string | null;
          delegation_id?: string | null;
          payload_asset_id?: string | null;
          at?: string;
        } | undefined;
        if (existing) {
          if (existing.event_id !== parsed.eventId || existing.run_id !== parsed.runId || existing.seq !== parsed.seq || existing.event_type !== parsed.type || existing.session_id !== parsed.sessionId || existing.delegation_id !== parsed.delegationId || existing.payload_asset_id !== (parsed.payloadRef?.assetId ?? null) || existing.at !== parsed.at) {
            throw new Error(existing.event_id === parsed.eventId ? "EVENT_ID_CONFLICT" : "EVENT_SEQUENCE_CONFLICT");
          }
          return;
        }
        db.prepare("INSERT INTO runtime_events (event_id, run_id, seq, event_type, session_id, delegation_id, payload_asset_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
          parsed.eventId, parsed.runId, parsed.seq, parsed.type, parsed.sessionId, parsed.delegationId, parsed.payloadRef?.assetId ?? null, parsed.at,
        );
      });
      return parsed;
    },

    getRuntimeEvents(runId) {
      getRunRow(db, runId);
      const rows = db.prepare("SELECT event_id, run_id, seq, event_type, session_id, delegation_id, payload_asset_id, at FROM runtime_events WHERE run_id = ? ORDER BY seq, event_id").all(runId) as Array<{ event_id: string; run_id: string; seq: number; event_type: string; session_id: string | null; delegation_id: string | null; payload_asset_id: string | null; at: string }>;
      const run = getRunRow(db, runId);
      return rows.map((row) => RuntimeEventSchema.parse({
        schemaVersion: "1",
        jobId: run.job_id,
        runId: row.run_id,
        generation: run.generation,
        candidateId: run.candidate_id,
        eventId: row.event_id,
        seq: row.seq,
        at: row.at,
        sessionId: row.session_id,
        delegationId: row.delegation_id,
        type: row.event_type,
        payloadRef: row.payload_asset_id ? (() => {
          try { return selectArtifact(db, row.payload_asset_id).ref; } catch { return null; }
        })() : null,
      }));
    },

    recordToolCall(call) {
      const callId = call.callId ?? `tool-call-${randomUUID()}`;
      const at = call.at ?? now();
      const existing = db.prepare("SELECT * FROM tool_calls WHERE run_id = ? AND request_id = ? AND request_hash = ?").get(call.runId, call.requestId, call.requestHash) as { call_id: string; request_hash: string; tool_name: string; tool_version: string; status: string; request_asset_id: string | null; result_asset_id: string | null; at: string } | undefined;
      if (existing) {
        return { callId: existing.call_id, runId: call.runId, requestId: call.requestId, requestHash: existing.request_hash, toolName: existing.tool_name, toolVersion: existing.tool_version, status: existing.status, requestAssetId: existing.request_asset_id, resultAssetId: existing.result_asset_id, at: existing.at };
      }
      db.prepare("INSERT INTO tool_calls (call_id, run_id, request_id, request_hash, tool_name, tool_version, status, request_asset_id, result_asset_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        callId, call.runId, call.requestId, call.requestHash, call.toolName, call.toolVersion, call.status, call.requestAssetId, call.resultAssetId, at,
      );
      return { ...call, callId, at };
    },

    getToolCalls(runId) {
      return db.prepare("SELECT call_id, run_id, request_id, request_hash, tool_name, tool_version, status, request_asset_id, result_asset_id, at FROM tool_calls WHERE run_id = ? ORDER BY at, call_id").all(runId).map((row) => {
        const value = row as { call_id: string; run_id: string; request_id: string; request_hash: string; tool_name: string; tool_version: string; status: string; request_asset_id: string | null; result_asset_id: string | null; at: string };
        return { callId: value.call_id, runId: value.run_id, requestId: value.request_id, requestHash: value.request_hash, toolName: value.tool_name, toolVersion: value.tool_version, status: value.status, requestAssetId: value.request_asset_id, resultAssetId: value.result_asset_id, at: value.at };
      });
    },

    async putArtifact(runId, kind, bytes) {
      getRunRow(db, runId);
      return insertArtifact(db, runId, kind, bytes);
    },

    getArtifact(assetId) {
      const artifact = selectArtifact(db, assetId);
      return { ref: artifact.ref, bytes: artifact.bytes };
    },

    close() { db.close(); },
  };
}
