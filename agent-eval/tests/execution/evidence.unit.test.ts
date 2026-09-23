import { expect, test } from 'bun:test';
import { scanEvidence } from '../../src/execution/evidence-safety.ts';
test('a completed leaking scan retains a failure fact without persisting the secret', () => {
    const scanned = scanEvidence({ output: { text: 'answer test-private-credential' }, diagnostics: 'test-private-credential' }, ['test-private-credential']);
    expect(scanned.fact).toEqual({ present: true, actual: { leaked: true }, source: 'evaluation:redaction-scan' });
    expect(JSON.stringify(scanned.value)).not.toContain('test-private-credential');
    expect(scanned.value.output.text).toContain('[REDACTED]');
});
test('clean and empty observed artifacts are available clean scans', () => {
    for (const value of [{ output: 'safe' }, {}]) {
        const scanned = scanEvidence(value, ['test-private-credential']);
        expect(scanned.value).toEqual(value);
        expect(scanned.fact).toMatchObject({ present: true, actual: { leaked: false } });
    }
});
test('escaped secrets and secret-bearing property names are removed without corrupting JSON', () => {
    const secret = 'private"\\\nvalue';
    const value: Record<string, unknown> = { [secret]: [secret, { text: `before ${secret} after` }] };
    const scanned = scanEvidence(value, [secret]);
    expect(scanned.fact.actual).toEqual({ leaked: true });
    expect(scanned.value).toEqual({ '[REDACTED]': ['[REDACTED]', { text: 'before [REDACTED] after' }] });
});
test('recognizable Langfuse secrets are redacted even without a configured value', () => {
    const scanned = scanEvidence({ error: 'credential sk-lf-example-123 exposed' }, []);
    expect(scanned.fact.actual).toEqual({ leaked: true });
    expect(scanned.value.error).toBe('credential [REDACTED] exposed');
});
