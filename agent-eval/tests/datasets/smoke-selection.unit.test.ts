import { expect, test } from 'bun:test';
import { flowmateAgentV1Dataset } from '../../src/datasets/cases.ts';

test('Smoke covers the seven agreed Cases while Full retains all 62', () => {
    const cases = flowmateAgentV1Dataset.cases;
    const smoke = cases.filter(task => task.tags.includes('smoke'));
    expect(cases).toHaveLength(62);
    expect(smoke.map(task => task.id).sort()).toEqual(['FM-001', 'FM-002', 'FM-027', 'FM-033', 'FM-046', 'FM-051', 'FM-055']);
    expect(smoke.filter(task => task.tags.includes('business'))).toHaveLength(5);
    expect(smoke.filter(task => task.tags.includes('research'))).toHaveLength(2);
    for (const id of ['FM-005', 'FM-013', 'FM-020', 'FM-024', 'FM-045', 'FM-057', 'FM-059'])
        expect(cases.find(task => task.id === id)?.tags).toContain('full');
    expect(cases.filter(task => task.tags.includes('holdout'))).toHaveLength(48);
});
