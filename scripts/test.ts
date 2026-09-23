import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const layers = ['unit', 'integration', 'e2e'] as const;
const selected = process.argv[2];
if (selected !== 'all' && !layers.includes(selected as typeof layers[number])) {
  console.error('Usage: bun run scripts/test.ts all|unit|integration|e2e');
  process.exit(2);
}
function files(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry => {
    if (entry.isSymbolicLink()) throw new Error(`Test discovery refuses symlink: ${dir}/${entry.name}`);
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? files(path) : [path];
  });
}
const discovered = ['tests', 'agent-eval/tests'].flatMap(files).sort();
const unclassified = discovered.filter(p => /(?:\.test|\.node-test)\.ts$/.test(p) && !/\.(unit|integration|e2e)\.test\.ts$/.test(p));
if (unclassified.length) throw new Error(`Unclassified tests: ${unclassified.join(', ')}`);
// Allow OS/tool paths, not developer model credentials, platform keys or .env.
const env: Record<string, string> = {};
for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']) {
  if (process.env[key]) env[key] = process.env[key]!;
}
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, '--no-env-file', ...args], { cwd: root, env, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
  const code = await child.exited;
  if (code !== 0) process.exit(code || 1);
}
if (selected === 'all') await run(['run', 'typecheck']);
for (const layer of selected === 'all' ? layers : [selected]) {
  const tests = discovered.filter(p => p.endsWith(`.${layer}.test.ts`));
  if (!tests.length) throw new Error(`No ${layer} tests found`);
  console.log(`${layer}: ${tests.length} test files`);
  await run(['test', '--isolate', '--timeout', '15000', ...tests.map(p => './' + p)]);
}
