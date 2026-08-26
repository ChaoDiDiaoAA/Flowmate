import { mkdtemp, readFile } from "node:fs/promises";
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

  it("uses the approved China calendar date for acquisition IDs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T16:30:00.000Z"));
    const { allocator } = await createTestAllocator();

    await expect(allocator.next("acquisition")).resolves.toBe("ACQ-20260826-0001");
  });
});
