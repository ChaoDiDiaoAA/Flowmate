import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { makeInvoiceCandidate } from "../../packages/contracts/src/invoice.ts";
import { openStore, type JobInput } from "../../packages/core/src/index.ts";

const jobInput: JobInput = { jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" };

async function withStore<T>(fn: (root: string, store: ReturnType<typeof openStore>) => Promise<T> | T): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "flowmate-store-"));
  const store = openStore(root);
  try {
    return await fn(root, store);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

describe("job and run repository", () => {
  it("accepts one candidate and keeps job state at candidate_ready", async () => {
    await withStore(async (_root, store) => {
      const job = store.createJob(jobInput);
      const run = store.startRun(job.id, jobInput.candidateId);
      const raw = await store.putArtifact(run.runId, "model.request", Buffer.from("{}"));
      const record = store.acceptCandidate(run, "req-1", raw, makeInvoiceCandidate());
      expect(record.runId).toBe(run.runId);
      expect(store.getJob(job.id).job.status).toBe("candidate_ready");
      expect(store.getJob(job.id).candidates).toHaveLength(1);
    });
  });

  it("rejects an old run after a newer generation starts", async () => {
    await withStore(async (_root, store) => {
      const job = store.createJob(jobInput);
      const old = store.startRun(job.id, jobInput.candidateId);
      store.finishRun(old.runId, "interrupted", "complete");
      const current = store.startRun(job.id, jobInput.candidateId);
      const raw = await store.putArtifact(current.runId, "model.request", Buffer.from("{}"));
      expect(() => store.acceptCandidate(old, "req-old", raw, makeInvoiceCandidate())).toThrow("STALE_RUN");
    });
  });

  it("persists cancellation intent and refuses a late candidate", async () => {
    await withStore(async (_root, store) => {
      const job = store.createJob(jobInput);
      const run = store.startRun(job.id, jobInput.candidateId);
      store.requestCancel(run.runId);
      const raw = await store.putArtifact(run.runId, "model.request", Buffer.from("{}"));
      expect(() => store.acceptCandidate(run, "req-late", raw, makeInvoiceCandidate())).toThrow("RUN_CANCELLED");
    });
  });

  it("deduplicates an identical request and rejects a conflicting replay", async () => {
    await withStore(async (_root, store) => {
      const job = store.createJob(jobInput);
      const run = store.startRun(job.id, jobInput.candidateId);
      const raw = await store.putArtifact(run.runId, "model.request", Buffer.from("{}"));
      const first = store.acceptCandidate(run, "req-dup", raw, makeInvoiceCandidate());
      const second = store.acceptCandidate(run, "req-dup", raw, makeInvoiceCandidate());
      expect(second.id).toBe(first.id);
      const different = makeInvoiceCandidate();
      different.fields.invoiceNumber.raw = "SYN-002";
      expect(() => store.acceptCandidate(run, "req-dup", raw, different)).toThrow("REQUEST_CONFLICT");
      expect(store.getJob(job.id).candidates).toHaveLength(1);
    });
  });

  it("marks residual active runs interrupted when the database is reopened", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-recovery-"));
    const first = openStore(root);
    const job = first.createJob(jobInput);
    const run = first.startRun(job.id, jobInput.candidateId);
    first.close();
    const reopened = openStore(root);
    try {
      expect(reopened.getJob(job.id).runs.find((item) => item.runId === run.runId)).toMatchObject({ status: "interrupted", cleanupStatus: "incomplete" });
    } finally {
      reopened.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("upgrades the legacy tool request key before accepting conflicting request ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-legacy-migration-"));
    const path = join(root, "flowmate.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES ('001_initial', '2026-09-01T00:00:00.000Z');
      CREATE TABLE jobs (id TEXT PRIMARY KEY, job_type TEXT NOT NULL, sample_id TEXT NOT NULL, input_hash TEXT NOT NULL, candidate_id TEXT NOT NULL, generation INTEGER NOT NULL, current_run_id TEXT, status TEXT NOT NULL, cancel_requested INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE agent_runs (run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, candidate_id TEXT NOT NULL, generation INTEGER NOT NULL, session_id TEXT, status TEXT NOT NULL, cleanup_status TEXT NOT NULL, cancel_reason TEXT, started_at TEXT NOT NULL, finished_at TEXT);
      CREATE TABLE artifacts (asset_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL, media_type TEXT NOT NULL, bytes BLOB NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE runtime_events (event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, seq INTEGER NOT NULL, event_type TEXT NOT NULL, payload_asset_id TEXT, at TEXT NOT NULL, UNIQUE(run_id, seq));
      CREATE TABLE tool_calls (call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, request_id TEXT NOT NULL, tool_name TEXT NOT NULL, tool_version TEXT NOT NULL, status TEXT NOT NULL, request_asset_id TEXT, result_asset_id TEXT, at TEXT NOT NULL, UNIQUE(run_id, request_id));
      CREATE TABLE delegations (delegation_id TEXT PRIMARY KEY, parent_run_id TEXT NOT NULL, child_run_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE test_candidates (candidate_id TEXT PRIMARY KEY, candidate_json TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    legacy.close();
    const store = openStore(root);
    store.close();
    const upgraded = new Database(path, { readonly: true });
    try {
      const indexes = upgraded.prepare("PRAGMA index_list(tool_calls)").all() as Array<{ name: string; unique: number }>;
      const requestKey = indexes.map((index) => upgraded.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{ name: string; seqno: number }>)
        .map((columns) => columns.sort((left, right) => left.seqno - right.seqno).map((column) => column.name));
      expect(requestKey).toContainEqual(["run_id", "request_id", "request_hash"]);
    } finally {
      upgraded.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
