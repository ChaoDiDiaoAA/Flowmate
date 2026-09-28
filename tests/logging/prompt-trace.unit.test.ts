import { describe, expect, it } from 'bun:test';
import { createPromptTraceBuffer } from '@flowmate/logging';

const reference = (runId: number, callSequence = 1) => ({ runId, sessionId: 8, nativeSessionId: `native-${runId}`, callSequence });
const entry = (event: 'model_request' | 'text_delta', summary: string, at = '2026-09-24T00:00:00.000Z') => ({ at, event, summary, truncated: false });

describe('PromptTraceBuffer', () => {
  it('bounds summaries and entries while retaining an active call', () => {
    const buffer = createPromptTraceBuffer();
    const ref = reference(1);
    buffer.begin(ref);
    for (let index = 0; index < 200; index += 1) buffer.append(ref, entry('text_delta', String(index)));
    buffer.append(ref, entry('model_request', 'x'.repeat(2_001)));

    const result = buffer.query(1);
    expect(result.availability).toBe('available');
    expect(result.calls[0]).toMatchObject({ state: 'active', droppedEntries: 1 });
    expect(result.calls[0].entries).toHaveLength(200);
    expect(result.calls[0].entries[0]).toMatchObject({ summary: '1', truncated: false });
    expect([...result.calls[0].entries[199].summary]).toHaveLength(2_000);
    expect(result.calls[0].entries[199].truncated).toBe(true);
  });

  it('truncates Unicode summaries by code point without splitting surrogate pairs', () => {
    const buffer = createPromptTraceBuffer();
    const ref = reference(60);
    buffer.begin(ref);
    buffer.append(ref, entry('text_delta', '😀'.repeat(2_001)));

    const summary = buffer.query(60).calls[0].entries[0].summary;
    expect([...summary]).toHaveLength(2_000);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.includes('\uFFFD')).toBe(false);
  });

  it('retains active calls while keeping only twenty completed calls and identifying evictions', () => {
    const buffer = createPromptTraceBuffer();
    const active = reference(22);
    buffer.begin(active);
    for (let runId = 1; runId <= 21; runId += 1) {
      const ref = reference(runId);
      buffer.begin(ref);
      buffer.append(ref, entry('model_request', `model call ${runId}`));
      buffer.end(ref);
    }

    expect(buffer.query(1)).toMatchObject({ availability: 'evicted', droppedCalls: 1, calls: [] });
    expect(buffer.query(2)).toMatchObject({ availability: 'available', calls: [{ state: 'ended' }] });
    expect(buffer.query(22)).toMatchObject({ availability: 'available', calls: [{ state: 'active' }] });
  });

  it('reports not-started and ignores late appends after a call ends', () => {
    const buffer = createPromptTraceBuffer();
    const ref = reference(50);
    expect(buffer.query(50)).toMatchObject({ availability: 'not-started', calls: [] });
    buffer.begin(ref);
    buffer.end(ref);
    buffer.append(ref, entry('text_delta', 'late event'));
    expect(buffer.query(50)).toMatchObject({ availability: 'available', calls: [{ state: 'ended', entries: [] }] });
  });

  it('keeps late observations attached to their original Run and call', () => {
    const buffer = createPromptTraceBuffer();
    const first = reference(70);
    const second = reference(71);
    buffer.begin(first);
    buffer.begin(second);
    buffer.append(first, entry('model_request', 'first Run'));
    buffer.end(first);
    buffer.append(first, entry('text_delta', 'late first-Run event'));
    buffer.append(second, entry('model_request', 'second Run'));

    expect(buffer.query(70)).toMatchObject({ availability: 'available', calls: [{ runId: 70, state: 'ended', entries: [{ summary: 'first Run' }] }] });
    expect(buffer.query(71)).toMatchObject({ availability: 'available', calls: [{ runId: 71, state: 'active', entries: [{ summary: 'second Run' }] }] });
  });

  it('clears active and ended diagnostic calls for a permanently deleted Session only', () => {
    const buffer = createPromptTraceBuffer();
    const removed = reference(80);
    const retained = { ...reference(81), sessionId: 9 };
    buffer.begin(removed);
    buffer.append(removed, entry('text_delta', 'deleted session'));
    buffer.end(removed);
    buffer.begin(retained);
    buffer.append(retained, entry('text_delta', 'other session'));
    buffer.clearSession(8);

    expect(buffer.query(80)).toMatchObject({ availability: 'not-started', calls: [] });
    expect(buffer.query(81)).toMatchObject({ availability: 'available', calls: [{ entries: [{ summary: 'other session' }] }] });
  });
});
