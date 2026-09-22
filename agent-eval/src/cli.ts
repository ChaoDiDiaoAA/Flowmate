import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLangfuseRuntime, doctor } from './langfuse/runtime.ts';
import { datasetName, syncStage } from './langfuse/datasets.ts';
import { formatExperimentCaseSummaries, replaySavedExperiment, runStageExperiment } from './langfuse/experiment.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = resolve(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function usage(): never {
  throw new Error([
    'usage: bun run eval -- doctor',
    'usage: bun run eval -- sync --stage P1',
    'usage: bun run eval -- run --stage P1 --mode fixture [--case <case-id>] [--execution-id <id>]',
    'usage: bun run eval -- run --stage P1 --mode live [--case provider-invoice-text]',
    'usage: bun run eval -- status --stage P1',
    'usage: bun run eval -- resend --report <absolute-summary.json>',
  ].join('\n'));
}

async function main(args: string[]): Promise<void> {
  const command = args[0];
  if (!command) usage();
  const runtime = await createLangfuseRuntime();
  try {
    if (command === 'doctor') {
      console.log(JSON.stringify(await doctor(runtime.client), null, 2));
      return;
    }
    if (command === 'sync') {
      const stage = option(args, '--stage') ?? 'P1';
      if (stage !== 'P1') throw new Error('Only P1 is implemented');
      console.log(JSON.stringify(await syncStage(runtime.client, stage), null, 2));
      return;
    }
    if (command === 'status') {
      const stage = option(args, '--stage') ?? 'P1';
      const output = [];
      for (const mode of ['fixture', 'live'] as const) {
        const dataset = await runtime.client.dataset.get(datasetName(stage, mode));
        output.push({ dataset: dataset.name, items: dataset.items.length, experiments: 'Open this dataset in the Langfuse UI; v4 events-only deployments do not expose the legacy dataset-runs API.' });
      }
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    if (command === 'run') {
      const stage = option(args, '--stage') ?? 'P1';
      const mode = option(args, '--mode');
      if (stage !== 'P1' || (mode !== 'fixture' && mode !== 'live')) usage();
      const result = await runStageExperiment(runtime.client, {
        stage,
        mode,
        repoRoot,
        caseId: option(args, '--case'),
        executionId: option(args, '--execution-id'),
      });
      console.log(formatExperimentCaseSummaries(result.caseSummaries));
      console.log(JSON.stringify({ executionId: result.executionId, dataset: result.dataset, reportFile: result.reportFile }, null, 2));
      return;
    }
    if (command === 'resend') {
      const report = option(args, '--report');
      if (!report) usage();
      console.log(await replaySavedExperiment(runtime.client, report));
      return;
    }
    usage();
  } finally {
    await runtime.shutdown();
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
