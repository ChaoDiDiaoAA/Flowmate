import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyHandoff } from "@flowmate/core";

export async function verifyHandoffFile(path: string): Promise<ReturnType<typeof verifyHandoff>> {
  try {
    const value = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
    return verifyHandoff(value);
  } catch (error) {
    return {
      ok: false,
      manifestHash: null,
      errors: [error instanceof Error ? error.message : "could not read handoff manifest"],
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const path = process.argv[2] ?? resolve(process.cwd(), "FlowmateData", "p0", "reports", "handoff.json");
  const report = await verifyHandoffFile(path);
  console.log(JSON.stringify({ path, ...report }, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
