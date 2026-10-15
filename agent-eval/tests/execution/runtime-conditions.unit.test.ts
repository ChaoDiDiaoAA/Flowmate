import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runtimeSourceConditions } from '../../src/execution/source.ts';
import { execFileSync } from 'node:child_process';

test('actual recorded conditions distinguish changes to the SDK tool schema and calculation definition', () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-tool-conditions-'));
    try {
        execFileSync('git',['init','-q'],{cwd:root});
        execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','fixture'],{cwd:root});
        const files = ['packages/runtime-pi/src/schema.ts', 'packages/employee-invoice/src/tools/calculate_invoice_amounts.ts'];
        for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), 'before'); }
        const before = runtimeSourceConditions(root);
        for (const file of files) writeFileSync(join(root, file), 'after');
        const after = runtimeSourceConditions(root);
        expect(after).not.toEqual(before);
        expect(after.files).toEqual([...files].sort().map(path => ({ path, text: 'after' })));
        expect(JSON.stringify(after)).not.toMatch(/"(?:hash|sha256|fingerprint)"/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
