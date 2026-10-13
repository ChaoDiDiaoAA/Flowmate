import { expect, test } from 'bun:test';
import { manifestSchema } from '../../src/dataset-loader/schema.ts';
import { dataset } from '../support/fixtures.ts';

test('dataset validation has no approval lifecycle or separate release record', () => {
    const { readiness: _, ...manifest } = dataset.manifest as typeof dataset.manifest & { readiness?: string };
    expect(manifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifestSchema.safeParse({ ...manifest, readiness: 'frozen' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, freeze: { at: '2026-10-13T00:00:00Z' } }).success).toBe(false);
});
