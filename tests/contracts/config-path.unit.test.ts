import { expect, it } from 'bun:test';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAbsoluteConfigPath } from '../../packages/contracts/src/config-path.ts';
import { WorkingDirectorySchema } from '../../packages/contracts/src/schemas.ts';

it('keeps Node absolute-path semantics for Windows and POSIX without importing Node in the shared validator', () => {
  for (const value of ['', '.', '..', '/', '//', '\\', '\\\\server\\share', '/tmp/data', '\\tmp\\data', 'C:', 'C:work',
    'C:/work', 'c:\\work', 'Z:\\', '1:/work', '工作目录', '工作:/data', 'relative/path', 'file:///tmp/data', ' C:/work',
    '/tmp/../data', 'C:\\work\\..\\data', '//server/share', '///', '\\\\?\\C:\\work', '\\\\?\\UNC\\server\\share']) {
    expect(isAbsoluteConfigPath(value, true)).toBe(win32.isAbsolute(value));
    expect(isAbsoluteConfigPath(value, false)).toBe(posix.isAbsolute(value));
  }
  expect(WorkingDirectorySchema.safeParse(process.platform === 'win32' ? 'C:\\work' : '/work').success).toBe(true);
  for (const value of ['relative', '', '/work\u0000', '/work\n', '/work\u007f'])
    expect(WorkingDirectorySchema.safeParse(value).success).toBe(false);
});

it('bundles the actual Personal Agent command validators for the browser without a Node path polyfill', async () => {
  const built = await Bun.build({ entrypoints: [fileURLToPath(new URL('../../packages/contracts/src/personal-agent-commands.ts', import.meta.url))],
    target: 'browser' });
  expect(built.success).toBe(true);
  for (const output of built.outputs) expect(await output.text()).not.toContain('node:path');
});
