import { expect, test } from 'bun:test';
import { shareCapture } from '../../src/adapters/host-research.ts';
import type { CaseExecutionResult } from '../../src/types.ts';
const observed=():CaseExecutionResult=>({identity:{executionId:'capture-unit',trialId:'capture-unit-1',caseId:'case',caseVersion:1},
  started:true,status:'completed',endpointReached:true,input:{prompt:'Original input',materials:[]},answer:null,artifacts:[],observations:[],
  evidence:{},configuration:{},usage:{},startedAt:'2026-10-28T00:00:00Z',endedAt:'2026-10-28T00:00:01Z'});

test('concurrent snapshots acquire once and a later settled read gets fresh original facts', async () => {
  let release!: () => void, reads = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const capture = shareCapture(async () => { const current = ++reads; await gate; const result = observed(); result.answer = 'Original revision ' + current; return result; });
  const a = capture(), b = capture(), c = capture();
  release();
  const values = await Promise.all([a, b, c]);
  expect(reads).toBe(1); expect(values.every(value => value.answer === 'Original revision 1')).toBe(true);
  expect((await capture()).answer).toBe('Original revision 2'); expect(reads).toBe(2);
});

test('a failed acquisition is not cached and each later explicit snapshot may read fresh', async () => {
  let reads = 0;
  const capture = shareCapture(() => { reads++; throw Error('Original read failure'); });
  await expect(capture()).rejects.toThrow('Original read failure');
  await expect(capture()).rejects.toThrow('Original read failure');
  expect(reads).toBe(2);
});
