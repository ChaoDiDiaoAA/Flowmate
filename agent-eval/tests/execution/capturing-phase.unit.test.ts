import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from '../../../tests/support/resources.ts';
import type { CaseExecutionResult } from '../../src/types.ts';
import type { AgentKernel, AgentTrial } from '../../src/adapters/agent.ts';
import { executeCase } from '../../src/execution/execute-case.ts';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function evidence() {
  const result:CaseExecutionResult={identity:{executionId:'capture-unit',trialId:'capture-unit-1',caseId:'case',caseVersion:1},
    started:true,status:'failed',endpointReached:false,input:{prompt:'Original input',materials:[]},answer:null,artifacts:[],observations:[],
    evidence:{},configuration:{},usage:{},startedAt:'2026-10-28T00:00:00Z',endedAt:'2026-10-28T00:00:01Z'};
  result.error = { code: 'tool_budget_exceeded', message: 'Original business tool budget failure', infrastructure: false };
  result.evidence.runs = { present: true, source: 'Original owned Run stop receipt', actual: [{ runId: 1, sessionId: 1, kind: 'agent', status: 'failed',
    startedAt: '2026-10-28T00:00:00Z', endedAt: '2026-10-28T00:00:01Z', stoppedAt: '2026-10-28T00:00:01Z', cleanup: { stopped: true, lateObservationRequired: false } }] };
  return result;
}
function trial(result = evidence()): AgentTrial {
  return { identity: result.identity, input: result.input, requires: [], configuration: {}, directory: mkdtempSync(join(tmpdir(), 'flowmate-capturing-phase-')) };
}
const close = async () => ({ present: true, actual: { closed: true, stopped: true, errors: [] }, source: 'Actual controlled close receipt' });

test('business completion leaves the actor deadline before complete capture and preserves its actual failure', async () => {
  const result = evidence(), phases: string[] = []; let captures = 0;
  const capture = async () => { captures++; await delay(90); return result; };
  const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'Controlled lifecycle' }), async prepare() {
    return { input: result.input, async execute(_signal, onQuiescent) { await delay(90); onQuiescent?.(result); return capture(); },
      snapshot: async options => options?.stopOnly ? result : capture(), cancel: async () => {}, close };
  } };
  const measured = await executeCase(kernel, trial(result), 150, 15, undefined, value => phases.push(value));
  expect(measured.execution).toMatchObject({ started: true, status: 'failed', error: { code: 'tool_budget_exceeded' } });
  expect(measured.stopFailed).toBe(false); expect(captures).toBe(1);
  expect(phases).toEqual(['preparing', 'executing', 'capturing', 'cleanup']);
});

test.each(['throws', 'times-out'] as const)('capture %s retains started and original business failure with a distinct evidence gap', async mode => {
  const result = evidence();
  const capture = async () => { if (mode === 'throws') throw Error('Original readback transport failure'); return new Promise<never>(() => {}); };
  const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'Controlled lifecycle' }), async prepare() {
    return { input: result.input, async execute(_signal, onQuiescent) { onQuiescent?.(result); return capture(); },
      snapshot: async options => options?.stopOnly ? result : capture(), cancel: async () => {}, close };
  } };
  const measured = await executeCase(kernel, trial(result), 40, 10);
  expect(measured.execution).toMatchObject({ started: true, status: 'failed', endpointReached: false, error: { code: 'tool_budget_exceeded' } });
  expect(measured.stopFailed).toBe(false);
  expect(measured.execution.evidence['capture-gaps']).toMatchObject({ present: false, actual: expect.any(Array) });
  expect(JSON.stringify(measured.execution.evidence['lifecycle-diagnostics'])).toContain('capturing');
  expect(measured.execution.evidence['lifecycle-diagnostics']).toMatchObject({ actual: { captureError: { stage: 'capturing', infrastructure: true,
    code: mode === 'throws' ? 'evidence_capture_failed' : 'evidence_capture_timeout' } } });
});

test('an actual actor timeout requests cancellation before any full capture and never waits long capture without stop proof', async () => {
  const result = evidence(), order: string[] = [];
  result.status = 'error'; result.error = { code: 'stop_unconfirmed', message: 'Original actor is still unconfirmed', infrastructure: true };
  (result.evidence.runs!.actual as Array<Record<string, unknown>>)[0]!.status = 'running';
  const kernel: AgentKernel = { readiness: () => ({ ready: true, reason: 'Controlled lifecycle' }), async prepare() {
    return { input: result.input, execute: async () => { order.push('execute'); return new Promise(() => {}); },
      snapshot: async options => { order.push(options?.stopOnly ? 'stop-probe' : 'full-capture'); if (!options?.stopOnly) return new Promise(() => {}); return result; },
      cancel: async () => { order.push('cancel'); }, close: async () => { order.push('close'); return close(); } };
  } };
  const measured = await executeCase(kernel, trial(result), 20, 10);
  expect(order).not.toContain('full-capture'); expect(order.indexOf('cancel')).toBeLessThan(order.indexOf('stop-probe'));
  expect(measured.stopFailed).toBe(true); expect(measured.execution.started).toBe(true);
});

test('cancellation during capture closes promptly and records the interrupted collection separately from known business failure', async () => {
  const result=evidence(),controller=new AbortController();let closed=false;
  const kernel:AgentKernel={readiness:()=>({ready:true,reason:'Controlled lifecycle'}),async prepare(){return{
    input:result.input,async execute(_signal,onQuiescent){onQuiescent?.(result);return new Promise(()=>{});},
    snapshot:async()=>result,cancel:async()=>{},close:async()=>{closed=true;return close();}
  };}};
  const measured=await executeCase(kernel,trial(result),1000,20,controller.signal,phase=>{if(phase==='capturing')controller.abort();});
  expect(closed).toBe(true);expect(measured.stopFailed).toBe(false);expect(measured.execution.error?.code).toBe('tool_budget_exceeded');
  expect(measured.execution.evidence['lifecycle-diagnostics']).toMatchObject({actual:{captureError:{code:'evidence_capture_cancelled',infrastructure:false}}});
});

test('cancellation interrupts finally capture after actor failure without waiting for the full readback', async () => {
  const result=evidence(),controller=new AbortController(),order:string[]=[];
  let entered!:()=>void,closed!:()=>void;
  const captureStarted=new Promise<void>(resolve=>{entered=resolve;}),hostClosed=new Promise<void>(resolve=>{closed=resolve;});
  const kernel:AgentKernel={readiness:()=>({ready:true,reason:'Controlled finally cancellation'}),async prepare(){return{
    input:result.input,execute:async()=>{throw Error('Original actor operation failed');},
    snapshot:async options=>{if(options?.stopOnly){order.push('stop-probe');return result;}order.push('full-capture');entered();await delay(250);return result;},
    cancel:async()=>{order.push('cancel');},close:async()=>{order.push('close');closed();return close();}
  };}};
  const running=executeCase(kernel,trial(result),1000,15,controller.signal);
  try{
    await captureStarted;controller.abort();
    const timelyClose=await Promise.race([hostClosed.then(()=>true),delay(100).then(()=>false)]);
    expect(timelyClose).toBe(true);
    const measured=await running;
    expect(order.indexOf('cancel')).toBeLessThan(order.indexOf('full-capture'));
    expect(measured.stopFailed).toBe(false);expect(measured.execution.started).toBe(true);
    expect(measured.execution.error?.code).toBe('tool_budget_exceeded');
    expect(measured.execution.evidence['lifecycle-diagnostics']).toMatchObject({actual:{captureError:{stage:'capturing',code:'evidence_capture_cancelled',infrastructure:false}}});
  }finally{await running;}
});

test('cancellation at the finally capture phase boundary starts no full acquisition', async () => {
  const result=evidence(),controller=new AbortController();let fullReads=0,closed=false;
  const kernel:AgentKernel={readiness:()=>({ready:true,reason:'Controlled phase boundary'}),async prepare(){return{
    input:result.input,execute:async()=>{throw Error('Original actor operation failed');},
    snapshot:async options=>{if(!options?.stopOnly)fullReads++;return result;},cancel:async()=>{},close:async()=>{closed=true;return close();}
  };}};
  const measured=await executeCase(kernel,trial(result),1000,15,controller.signal,phase=>{if(phase==='capturing')controller.abort();});
  expect(fullReads).toBe(0);expect(closed).toBe(true);expect(measured.stopFailed).toBe(false);
  expect(measured.execution.error?.code).toBe('tool_budget_exceeded');
  expect(measured.execution.evidence['lifecycle-diagnostics']).toMatchObject({actual:{captureError:{code:'evidence_capture_cancelled'}}});
});
