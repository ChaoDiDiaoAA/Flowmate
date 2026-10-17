import { DiagnosticLogEntrySchema, type DiagnosticLogEntry } from '@flowmate/contracts';

export function createRuntimeLogBuffer() {
  const entries: DiagnosticLogEntry[] = [];
  let dropped = 0, closed = false;
  return {
    write(event: DiagnosticLogEntry): void {
      if (closed) return;
      try {
        const value = DiagnosticLogEntrySchema.safeParse({ at: event.at, level: event.level, component: event.component, event: event.event,
          ...(event.code === undefined ? {} : { code: event.code }), ...(event.runId === undefined ? {} : { runId: event.runId }) });
        if (!value.success) { dropped++; return; }
        if (entries.length === 256) { entries.shift(); dropped++; }
        entries.push(value.data);
      } catch { dropped++; }
    },
    snapshot() { return { entries: structuredClone(entries), dropped }; },
    async close(): Promise<void> { closed = true; },
  };
}
