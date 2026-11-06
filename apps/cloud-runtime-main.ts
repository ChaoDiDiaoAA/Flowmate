import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { createCloudAuthorityCallbacksClient } from './cloud-authority-rpc.ts';
import { createCloudRuntimeService } from './cloud-runtime-service.ts';

const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !value.includes('\0'));
const configuration = z.object({ version: z.literal(1), root: absolutePath, runtimeSocketPath: absolutePath,
  authoritySocketPath: absolutePath, modelSocketPath: absolutePath }).strict().refine(value =>
  new Set([value.runtimeSocketPath, value.authoritySocketPath, value.modelSocketPath]).size === 3);

/** The Runtime reads only its own configuration and the Authority's public tool definitions. */
export async function runCloudRuntimeMain(configPath: string): Promise<boolean> {
  if (process.platform !== 'linux' || !absolutePath.safeParse(configPath).success) return false;
  let raw: unknown;
  try {
    const info = lstatSync(configPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) return false;
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch { return false; }
  const parsed = configuration.safeParse(raw); if (!parsed.success) return false;
  const tools = await createCloudAuthorityCallbacksClient(parsed.data.authoritySocketPath).runtimeTools();
  if (!tools.ok) return false;
  const { version: _version, ...options } = parsed.data;
  const opened = await createCloudRuntimeService({ ...options, tools: tools.data });
  if (!opened.ok) return false;
  let signal!: () => void;
  const requested = new Promise<void>(resolveStop => { signal = resolveStop; });
  process.once('SIGTERM', signal); process.once('SIGINT', signal);
  process.stdout.write('[Flowmate] cloud_runtime_ready\n');
  await requested;
  process.off('SIGTERM', signal); process.off('SIGINT', signal);
  return (await opened.data.close()).ok;
}

if (import.meta.main) {
  const result = process.argv.length === 3 && await runCloudRuntimeMain(process.argv[2]!).catch(() => false);
  if (!result) { process.stderr.write('[Flowmate] cloud_runtime_failed\n'); process.exitCode = 1; }
}
