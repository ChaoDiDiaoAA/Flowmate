import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdAllocator } from "../src/ids.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })),
    ),
  );
});

async function createTestAllocator() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "flowmate-ids-"));
  temporaryRoots.push(dataRoot);
  return { allocator: createIdAllocator({ dataRoot, mineruMaxFilesPerRun: 200 }), dataRoot };
}

async function createTestLockPath(): Promise<{ dataRoot: string; lockPath: string }> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "flowmate-ids-"));
  temporaryRoots.push(dataRoot);
  const manifestsDirectory = path.join(dataRoot, "manifests");
  await mkdir(manifestsDirectory, { recursive: true });
  return { dataRoot, lockPath: path.join(manifestsDirectory, "id-counters.lock") };
}

describe("IdAllocator", () => {
  it("allocates the specified first ID for every P0 entity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T12:00:00+08:00"));
    const { allocator } = await createTestAllocator();

    await expect(allocator.next("source")).resolves.toBe("SRC-000001");
    await expect(allocator.next("artifact")).resolves.toBe("ART-000001");
    await expect(allocator.next("knowledge")).resolves.toBe("KNOW-000001");
    await expect(allocator.next("sample")).resolves.toBe("SAMPLE-000001");
    await expect(allocator.next("business")).resolves.toBe("BIZ-000001");
    await expect(allocator.next("acquisition")).resolves.toBe("ACQ-20260826-0001");
  });

  it("persists counters atomically and never returns a repeated sequential ID", async () => {
    const { allocator, dataRoot } = await createTestAllocator();

    const first = await allocator.next("source");
    const second = await allocator.next("source");

    expect(first).toBe("SRC-000001");
    expect(second).toBe("SRC-000002");
    await expect(
      readFile(path.join(dataRoot, "manifests", "id-counters.json"), "utf8"),
    ).resolves.toContain('"source": 2');
  });

  it("coordinates concurrent allocations from independent allocators", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "flowmate-ids-"));
    temporaryRoots.push(dataRoot);
    const config = { dataRoot, mineruMaxFilesPerRun: 200 };
    const firstAllocator = createIdAllocator(config);
    const secondAllocator = createIdAllocator(config);

    const ids = await Promise.all([
      firstAllocator.next("source"),
      secondAllocator.next("source"),
    ]);

    expect(new Set(ids)).toEqual(new Set(["SRC-000001", "SRC-000002"]));
    await expect(
      readFile(path.join(dataRoot, "manifests", "id-counters.json"), "utf8"),
    ).resolves.toContain('"source": 2');
  });

  it("keeps a stale crashed lock and reports manual recovery instead of reclaiming it", async () => {
    const { lockPath } = await createTestLockPath();
    const owner = { token: "crashed-owner", pid: 999_999 };
    await writeFile(lockPath, JSON.stringify(owner), "utf8");
    const oneMinuteAgo = new Date(Date.now() - 60_000);
    await utimes(lockPath, oneMinuteAgo, oneMinuteAgo);

    await expect(createIdAllocator({ dataRoot: path.dirname(path.dirname(lockPath)), mineruMaxFilesPerRun: 200 }).next("source"))
      .rejects.toThrow(/manually remove.*id-counters\.lock/i);

    await expect(readFile(lockPath, "utf8")).resolves.toBe(JSON.stringify(owner));
  });

  it("does not let another allocator replace a held lock", async () => {
    const { lockPath } = await createTestLockPath();
    await mkdir(lockPath);

    await expect(
      createIdAllocator({ dataRoot: path.dirname(path.dirname(lockPath)), mineruMaxFilesPerRun: 200 }).next("source"),
    ).rejects.toThrow(/manually remove.*id-counters\.lock/i);

    await expect(stat(lockPath)).resolves.toBeDefined();
  });

  it("uses the approved China calendar date for acquisition IDs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T16:30:00.000Z"));
    const { allocator } = await createTestAllocator();

    await expect(allocator.next("acquisition")).resolves.toBe("ACQ-20260826-0001");
  });
});
