import { parseArgs } from "node:util";
import { readFile, rename, writeFile } from "node:fs/promises";
import {
  AcquisitionOrchestrator,
  recoverStaleRecoveryLock,
  type Clock,
} from "./acquisition-orchestrator.js";
import { CatalogOutbox, type CatalogOutboxEntry } from "./catalog-outbox.js";
import { resolveConfig } from "./config.js";
import { initializeDataLayout } from "./filesystem-layout.js";
import { createIdAllocator } from "./ids.js";
import { OpenCliGateway } from "./opencli-gateway.js";
import { ObsidianCatalogWriter } from "./obsidian-catalog-writer.js";
import { initializeObsidianVault } from "./obsidian-templates.js";
import { SpawnProcessRunner } from "./process-runner.js";
import { redactSensitiveDetails } from "./redaction.js";
import { SourcePolicyRepository } from "./source-policy-repository.js";

const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

async function main(): Promise<void> {
  const [command, ...argumentsAfterCommand] = process.argv.slice(2);
  if (command === "discover") {
    parseArgs({ args: argumentsAfterCommand, allowPositionals: false, strict: true });
    const gateway = new OpenCliGateway(new SpawnProcessRunner());
    process.stdout.write(`${JSON.stringify(await gateway.discover(), null, 2)}\n`);
    return;
  }
  if (command === "acquire") {
    const request = parseAcquireRequest(argumentsAfterCommand);
    const config = resolveConfig(process.env);
    const paths = await initializeDataLayout(config.dataRoot);
    const sourcePolicy = await new SourcePolicyRepository(paths).load(request.sourceId);
    const orchestrator = new AcquisitionOrchestrator(
      createIdAllocator(config),
      new OpenCliGateway(new SpawnProcessRunner()),
      paths,
      systemClock,
      sourcePolicy,
    );
    process.stdout.write(`${JSON.stringify(await orchestrator.run(request), null, 2)}\n`);
    return;
  }
  if (command === "recover") {
    parseArgs({ args: argumentsAfterCommand, allowPositionals: false, strict: true });
    const config = resolveConfig(process.env);
    const paths = await initializeDataLayout(config.dataRoot);
    const recovered = await recoverStaleRecoveryLock(paths);
    process.stdout.write(`${recovered ? "recovery-lock-cleared" : "no-recovery-lock"}\n`);
    return;
  }
  if (command === "catalog-flush") {
    const { values } = parseArgs({
      args: argumentsAfterCommand,
      options: { outbox: { type: "string" } },
      allowPositionals: false,
      strict: true,
    });
    const outboxPath = requiredOption(values.outbox, "outbox");
    const entries = JSON.parse(await readFile(outboxPath, "utf8")) as CatalogOutboxEntry[];
    if (!Array.isArray(entries)) throw new Error("Catalog outbox must be a JSON array");
    const config = resolveConfig(process.env);
    const paths = await initializeDataLayout(config.dataRoot);
    await initializeObsidianVault(paths.vault);
    const outbox = new CatalogOutbox(entries);
    try {
      const written = await outbox.flush(new ObsidianCatalogWriter(paths.vault));
      process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
    } finally {
      await writeJsonAtomically(outboxPath, outbox.entries());
    }
    return;
  }
  if (command !== "init") {
    throw new Error(`Unknown data-workbench command: ${command ?? "<missing>"}`);
  }
  parseArgs({ args: argumentsAfterCommand, allowPositionals: false, strict: true });
  const config = resolveConfig(process.env);
  const paths = await initializeDataLayout(config.dataRoot);
  await initializeObsidianVault(paths.vault);
  process.stdout.write(`${config.dataRoot}\n`);
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function parseAcquireRequest(argumentsAfterCommand: string[]) {
  const { values } = parseArgs({
    args: normalizeArgValues(argumentsAfterCommand),
    options: {
      "source-id": { type: "string" },
      site: { type: "string" },
      command: { type: "string" },
      arg: { type: "string", multiple: true },
    },
    allowPositionals: false,
    strict: true,
  });
  return {
    sourceId: requiredOption(values["source-id"], "source-id"),
    site: requiredOption(values.site, "site"),
    command: requiredOption(values.command, "command"),
    args: values.arg ?? [],
  };
}

function normalizeArgValues(argumentsAfterCommand: string[]): string[] {
  return argumentsAfterCommand.flatMap((argument, index) => {
    const next = argumentsAfterCommand[index + 1];
    if (argument === "--arg" && next?.startsWith("-")) {
      return [`--arg=${next}`];
    }
    if (index > 0 && argumentsAfterCommand[index - 1] === "--arg" && argument.startsWith("-")) {
      return [];
    }
    return [argument];
  });
}

function requiredOption(value: string | undefined, option: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required option: --${option}`);
  }
  return value;
}

main().catch((error: unknown) => {
  process.stderr.write(`${redactSensitiveDetails(error instanceof Error ? error.message : String(error))}\n`);
  process.exitCode = 1;
});
