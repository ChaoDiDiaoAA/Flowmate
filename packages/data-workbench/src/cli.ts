import { parseArgs } from "node:util";
import { AcquisitionOrchestrator, type Clock } from "./acquisition-orchestrator.js";
import { resolveConfig } from "./config.js";
import { initializeDataLayout } from "./filesystem-layout.js";
import { createIdAllocator } from "./ids.js";
import { OpenCliGateway } from "./opencli-gateway.js";
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
  if (command !== "init") {
    throw new Error(`Unknown data-workbench command: ${command ?? "<missing>"}`);
  }
  parseArgs({ args: argumentsAfterCommand, allowPositionals: false, strict: true });
  const config = resolveConfig(process.env);
  await initializeDataLayout(config.dataRoot);
  process.stdout.write(`${config.dataRoot}\n`);
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
