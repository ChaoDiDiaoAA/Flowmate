import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openStore, persistRuntimeEvent } from "../../packages/core/src/index.ts";

describe("runtime event evidence", () => {
  it("persists ordered events with the real Run and Session identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-events-"));
    const store = openStore(root);
    try {
      const job = store.createJob({ jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" });
      const run = store.startRun(job.id, job.candidateId);
      store.attachSession({ jobId: job.id, runId: run.runId, generation: run.generation, candidateId: job.candidateId }, "session-real");
      const first = {
        schemaVersion: "1" as const,
        jobId: job.id,
        runId: run.runId,
        generation: run.generation,
        candidateId: job.candidateId,
        eventId: "event-1",
        seq: 0,
        at: new Date().toISOString(),
        sessionId: "session-real",
        delegationId: null,
        type: "agent.started",
        payloadRef: null,
      };
      const second = { ...first, eventId: "event-2", seq: 1, type: "agent.finished" };
      persistRuntimeEvent(store, second);
      persistRuntimeEvent(store, first);
      expect(store.getRuntimeEvents(run.runId).map((event) => [event.seq, event.type])).toEqual([[0, "agent.started"], [1, "agent.finished"]]);
      expect(store.getJob(job.id).runs[0]?.sessionId).toBe("session-real");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting sequence instead of overwriting evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-events-conflict-"));
    const store = openStore(root);
    try {
      const job = store.createJob({ jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" });
      const run = store.startRun(job.id, job.candidateId);
      const base = { schemaVersion: "1" as const, jobId: job.id, runId: run.runId, generation: run.generation, candidateId: job.candidateId, eventId: "event-1", seq: 0, at: new Date().toISOString(), sessionId: null, delegationId: null, type: "turn.started", payloadRef: null };
      store.recordRuntimeEvent(base);
      expect(() => store.recordRuntimeEvent({ ...base, eventId: "event-other", type: "turn.finished" })).toThrow("EVENT_SEQUENCE_CONFLICT");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects reusing an event id with a different sequence or payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "flowmate-events-id-conflict-"));
    const store = openStore(root);
    try {
      const job = store.createJob({ jobType: "invoice-extract", sampleId: "SYN-001", inputHash: "a".repeat(64), candidateId: "candidate-1" });
      const run = store.startRun(job.id, job.candidateId);
      const base = { schemaVersion: "1" as const, jobId: job.id, runId: run.runId, generation: run.generation, candidateId: job.candidateId, eventId: "event-stable", seq: 0, at: new Date().toISOString(), sessionId: null, delegationId: null, type: "turn.started", payloadRef: null };
      store.recordRuntimeEvent(base);
      expect(() => store.recordRuntimeEvent({ ...base, seq: 1 })).toThrow("EVENT_ID_CONFLICT");
      expect(() => store.recordRuntimeEvent({ ...base, type: "turn.finished" })).toThrow("EVENT_ID_CONFLICT");
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
