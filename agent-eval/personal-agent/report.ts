import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { scenarios, type ScenarioId } from './scenarios.ts';

const value = z.union([z.boolean(), z.number().finite(), z.null()]);
const check = z.object({ id: z.string().min(1), expected: value, actual: value }).strict();
const caseRecord = z.object({
  id: z.string().min(1), version: z.number().int().positive(), state: z.enum(['passed', 'failed']),
  checks: z.array(check),
  refs: z.record(z.number().int().positive()).optional(),
  measurements: z.record(z.number().finite().nonnegative().nullable()).optional(),
  elapsedMs: z.number().finite().nonnegative().optional(),
}).strict();

type CaseRecord = z.infer<typeof caseRecord>;
type Selected = { id: string; version: number; checks: readonly string[] };

// Bun JUnit emits a self-closing testcase for a pass and a child element for a failure or skip.
export function passingAssertionCount(xml: string, title: string): number {
  const rows = [...xml.matchAll(/<testcase\s+([^<>]*?)(\/>|>[\s\S]*?<\/testcase>)/g)]
    .filter(row => /(?:^|\s)name="([^"]*)"/.exec(row[1])?.[1] === title);
  if (rows.length !== 1 || rows[0][2] !== '/>') return 0;
  const count = Number(/(?:^|\s)assertions="(\d+)"/.exec(rows[0][1])?.[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

export function assessCases<T extends Selected>(selected: readonly T[], records: readonly unknown[]) {
  const parsed = records.map(record => caseRecord.safeParse(record));
  const accepted = parsed.flatMap(result => result.success ? [result.data] : []);
  const cases = selected.map(definition => {
    const rows = accepted.filter(record => record.id === definition.id);
    const result = rows.length === 1 ? rows[0] : null;
    const gaps = definition.checks.filter(id => {
      const checks = result?.checks.filter(assertion => assertion.id === id);
      return checks?.length !== 1 || checks[0].expected !== checks[0].actual;
    });
    const state = result?.state === 'passed' && gaps.length === 0 && result.version === definition.version
      ? 'passed' : rows.length === 0 ? 'not-run' : 'failed';
    return { ...definition, state, gaps, result };
  });
  return { ok: selected.length > 0 && accepted.length === selected.length && parsed.every(row => row.success)
    && cases.every(row => row.state === 'passed'), cases };
}

export function scenario(id: ScenarioId, execute: (evidence: {
  check: (id: string, expected: z.infer<typeof value>, actual: z.infer<typeof value>) => void;
  refs: NonNullable<CaseRecord['refs']>;
  measurements: NonNullable<CaseRecord['measurements']>;
}) => Promise<void>) {
  return async () => {
    const started = performance.now();
    const record: CaseRecord = { id, version: scenarios[id].version, state: 'failed', checks: [], refs: {}, measurements: {} };
    try {
      await execute({
        refs: record.refs!,
        measurements: record.measurements!,
        check(id, expected, actual) {
          record.checks.push({ id, expected, actual });
          if (expected !== actual) throw Error(`Scenario assertion failed: ${id}`);
        },
      });
      record.state = 'passed';
    } finally {
      const path = process.env.FLOWMATE_PERSONAL_CASE_EVIDENCE;
      if (path) appendFileSync(path, JSON.stringify(caseRecord.parse({ ...record, elapsedMs: performance.now() - started })) + '\n');
    }
  };
}
