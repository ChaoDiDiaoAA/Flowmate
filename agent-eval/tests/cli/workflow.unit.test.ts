import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function repo() { const root = mkdtempSync(join(tmpdir(), 'workflow-cli-')); roots.push(root); return root; }
test('new CLI groups dispatch the same typed workflow and preserve blocked Gate exit code 2', async () => {
    const root = repo(), output = spyOn(console, 'log').mockImplementation(() => {}), oldExit = process.exitCode;
    try {
        await main(['trace', 'list'], root); expect(JSON.parse(String(output.mock.calls.at(-1)![0]))).toMatchObject({ action: 'trace.list', data: { items: [] } });
        await main(['gate', 'check', '--baseline-id', 'missing', '--experiment-id', 'missing', '--arm-id', 'candidate', '--full-release'], root);
        expect(process.exitCode).toBe(2); expect(JSON.parse(String(output.mock.calls.at(-1)![0])).data.gate.status).toBe('blocked');
    } finally { output.mockRestore(); process.exitCode = oldExit ?? 0; }
});
test('CLI JSON request files execute actual settings writes rather than printing an unimplemented command', async () => {
    const root = repo(), input = join(root, 'settings.json'), output = spyOn(console, 'log').mockImplementation(() => {}), oldExit = process.exitCode;
    writeFileSync(input, JSON.stringify({ action: 'settings.save', settings: { capture: true, upload: false, mining: false } }));
    try {
        await main(['workflow', '--file', input], root);
        await main(['observability', 'get'], root);
        expect(JSON.parse(String(output.mock.calls.at(-1)![0])).data.settings).toEqual({ capture: true, upload: false, mining: false });
        await expect(main(['run', '--dataset', 'missing', '--benchmark-revision', '0'], root)).rejects.toThrow('positive');
    } finally { output.mockRestore(); process.exitCode = oldExit ?? 0; }
});
