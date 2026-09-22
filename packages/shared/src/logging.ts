import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type SafeLogEvent = {
  at: string;
  level: 'info' | 'warn' | 'error';
  component: string;
  runId?: number;
  event: string;
  code?: string;
};

export interface SafeLogger {
  write(event: SafeLogEvent): void;
  close(): Promise<void>;
}

export function createLogger(logsDir: string, options: { maxBytes?: number; backups?: number } = {}): SafeLogger {
  mkdirSync(logsDir, { recursive: true });
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const backups = Math.max(0, options.backups ?? 2);
  const file = join(logsDir, 'flowmate.log');
  let reportedFailure = false;

  function rotate(requiredBytes: number): void {
    let size = 0;
    try { size = statSync(file).size; } catch { return; }
    if (size + requiredBytes <= maxBytes) return;
    for (let index = backups - 1; index >= 1; index -= 1) {
      const from = `${file}.${index}`;
      const to = `${file}.${index + 1}`;
      try { renameSync(from, to); } catch { /* missing backup is expected */ }
    }
    if (backups > 0) {
      try { renameSync(file, `${file}.1`); } catch { /* current file may be absent */ }
    } else {
      try { writeFileSync(file, '', 'utf8'); } catch { /* write below reports failure */ }
    }
  }

  function reportFailure(): void {
    if (reportedFailure) return;
    reportedFailure = true;
    try { process.stderr.write('Flowmate logger write failed.\n'); } catch { /* stderr is best effort */ }
  }

  return {
    write(event) {
      const line = `${JSON.stringify(event)}\n`;
      try {
        rotate(Buffer.byteLength(line, 'utf8'));
        appendFileSync(file, line, 'utf8');
      } catch {
        reportFailure();
      }
    },
    close: async () => undefined,
  };
}
