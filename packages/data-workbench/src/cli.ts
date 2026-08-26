import { parseArgs } from "node:util";
import { resolveConfig } from "./config.js";
import { initializeDataLayout } from "./filesystem-layout.js";
import { OpenCliGateway } from "./opencli-gateway.js";
import { SpawnProcessRunner } from "./process-runner.js";

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [command] = positionals;
  if (command === "discover") {
    const gateway = new OpenCliGateway(new SpawnProcessRunner());
    process.stdout.write(`${JSON.stringify(await gateway.discover(), null, 2)}\n`);
    return;
  }
  if (command !== "init") {
    throw new Error(`Unknown data-workbench command: ${command ?? "<missing>"}`);
  }
  const config = resolveConfig(process.env);
  await initializeDataLayout(config.dataRoot);
  process.stdout.write(`${config.dataRoot}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
