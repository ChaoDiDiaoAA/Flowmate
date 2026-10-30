import { expect, test } from 'bun:test';
import { reportFixture } from '../support/fixtures.ts';
import { reportTraces } from '../../src/execution/trace.ts';

test('Benchmark trace preserves observed input, source identity and failures while excluding independent Gold', () => {
  const report = reportFixture();
  report.trials[0]!.caseConditions = { gold: { answer: 'PRIVATE_REFERENCE_ONLY' } };
  report.trials[0]!.status = 'FAIL';
  const trace = reportTraces(report)[0]!;
  expect(trace.id.replaceAll('-', '')).toBe(report.trials[0]!.traceId);
  expect(trace.source).toEqual({ kind: 'evaluation', executionId: 'unit', trialId: 'trial-1' });
  expect(trace.input.prompt).toBe(report.trials[0]!.execution!.input.prompt);
  expect(trace.status).toBe('FAIL');
  expect(trace.complete).toBe(true);
  expect(JSON.stringify(trace)).not.toContain('PRIVATE_REFERENCE_ONLY');
});

test('unproven stopping and unfinished observations remain explicit trace gaps', () => {
  const report = reportFixture();
  report.trials[0]!.execution!.evidence.cleanup!.actual = { stopped: false, closed: false };
  report.trials[0]!.execution!.observations = [{ id: 'open', kind: 'tool', name: 'read', startedAt: report.startedAt, endedAt: null }];
  const trace = reportTraces(report)[0]!;
  expect(trace.complete).toBe(false);
  expect(trace.gaps).toContain('run-stop-unconfirmed');
  expect(trace.gaps).toContain('observation-unfinished:open');
});

test('only explicitly supplied visible material bytes are captured; quality reference files are never inferred', () => {
  const report = reportFixture(), content = Buffer.from([1, 2, 3]).toString('base64');
  const trace = reportTraces(report, { sample: [{ path: 'voxel51/000001/original.png', encoding: 'base64', content, bytes: 3 }] })[0]!;
  expect(trace.materials.find(material => material.path === 'voxel51/000001/original.png')).toEqual({ id: 'source-1',
    path: 'voxel51/000001/original.png', encoding: 'base64', content });
  expect(trace.materials.some(material => material.path?.startsWith('quality-controls/'))).toBe(false);
});
