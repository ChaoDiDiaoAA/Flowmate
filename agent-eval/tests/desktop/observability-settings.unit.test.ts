import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import { readObservabilitySettings } from '../../src/observability-settings.ts';
import { readObservabilitySettings as compatibilityRead, saveObservabilitySettings } from '../../src/desktop/workflow.ts';

test('the lightweight reader defaults off without creating files and preserves the controller settings path', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-observability-reader-'));
    const first = readObservabilitySettings(root); expect(first).toEqual({ capture: false, upload: false, mining: false });
    first.capture = true; expect(readObservabilitySettings(root).capture).toBe(false);
    expect(existsSync(join(root, 'agent-eval'))).toBe(false);
    expect(compatibilityRead).toBe(readObservabilitySettings);
    saveObservabilitySettings(root, { capture: true, upload: false, mining: true });
    expect(readObservabilitySettings(root)).toEqual({ capture: true, upload: false, mining: true });
    expect(existsSync(join(root, 'agent-eval/configs/observability.json'))).toBe(true);
});
test('the lightweight reader rejects malformed JSON, invalid flags and non-file settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-observability-invalid-')), configs = join(root, 'agent-eval/configs');
    mkdirSync(configs, { recursive: true }); const file = join(configs, 'observability.json');
    writeFileSync(file, '{'); expect(() => readObservabilitySettings(root)).toThrow();
    writeFileSync(file, JSON.stringify({ capture: 'true', upload: false, mining: false })); expect(() => readObservabilitySettings(root)).toThrow();
    writeFileSync(file, JSON.stringify({ capture: true, upload: false, mining: false, extra: true })); expect(() => readObservabilitySettings(root)).toThrow();
    const second = mkdtempSync(join(tmpdir(), 'flowmate-observability-nonfile-'));
    mkdirSync(join(second, 'agent-eval/configs/observability.json'), { recursive: true });
    expect(() => readObservabilitySettings(second)).toThrow('Linked or invalid curation file');
});
test('the lightweight reader rejects a linked configuration directory rather than reading outside the workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-observability-linked-')), outside = mkdtempSync(join(tmpdir(), 'flowmate-observability-outside-'));
    mkdirSync(join(root, 'agent-eval')); writeFileSync(join(outside, 'observability.json'), JSON.stringify({ capture: true, upload: true, mining: true }));
    symlinkSync(outside, join(root, 'agent-eval/configs'), 'junction');
    expect(() => readObservabilitySettings(root)).toThrow('Linked or invalid curation directory');
});
