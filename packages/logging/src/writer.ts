import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiagnosticRecord, LogConfig, LogLevel, LoggerPort } from '../../contracts/src/index.ts';
import { productError } from '../../contracts/src/errors.ts';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const SECRET_KEY = /(token|secret|password|api[-_]?key|authorization|prompt|gold|oracle|stack|content|body|text)/i;

export class JsonlLogger implements LoggerPort {
  private closed = false;
  private degraded = false;
  private droppedRecords = 0;
  private bytesTotal = 0;
  private filePath: string;
  private segment = 0;
  private fileBytes = 0;

  constructor(private readonly input: { instanceId: string; processInstanceId: string; logRoot: string; config: LogConfig }) {
    for (const key of ['maxRecordBytes', 'maxFileBytes', 'maxTotalBytes', 'queueLimit'] as const) {
      if (!Number.isSafeInteger(input.config[key]) || input.config[key] < 1) throw new RangeError(`${key} must be a positive integer`);
    }
    mkdirSync(input.logRoot, { recursive: true });
    this.bytesTotal = readdirSync(input.logRoot).filter((name) => name.endsWith('.jsonl')).reduce((total, name) => total + statSync(join(input.logRoot, name)).size, 0);
    if (this.bytesTotal >= input.config.maxTotalBytes) this.degraded = true;
    this.filePath = join(input.logRoot, `p0-${input.processInstanceId}.jsonl`);
    if (!existsSync(this.filePath)) writeFileSync(this.filePath, '', { flag: 'wx' });
    this.fileBytes = statSync(this.filePath).size;
  }

  write(record: DiagnosticRecord): void {
    if (this.closed || this.degraded || RANK[record.level] < RANK[this.input.config.minLevel]) {
      if (this.closed || this.degraded) this.droppedRecords += 1;
      return;
    }
    const safe = sanitizeRecord(record);
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      instanceId: this.input.instanceId,
      processInstanceId: this.input.processInstanceId,
      ...safe,
    }) + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > Math.min(this.input.config.maxRecordBytes, this.input.config.maxFileBytes) || this.bytesTotal + bytes > this.input.config.maxTotalBytes) {
      this.degraded = true;
      this.droppedRecords += 1;
      return;
    }
    try {
      if (this.fileBytes + bytes > this.input.config.maxFileBytes) {
        do { this.segment += 1; this.filePath = join(this.input.logRoot, `p0-${this.input.processInstanceId}-${this.segment}.jsonl`); } while (existsSync(this.filePath));
        writeFileSync(this.filePath, '', { flag: 'wx' });
        this.fileBytes = 0;
      }
      appendFileSync(this.filePath, line, { encoding: 'utf8' });
      this.fileBytes += bytes;
      this.bytesTotal += bytes;
    } catch {
      this.degraded = true;
      this.droppedRecords += 1;
    }
  }

  health(): { degraded: boolean; droppedRecords: number; reason?: string } {
    return { degraded: this.degraded, droppedRecords: this.droppedRecords, ...(this.degraded ? { reason: 'log quota or append failed' } : {}) };
  }

  async flush(timeoutMs: number): Promise<{ complete: boolean }> {
    if (timeoutMs < 0) throw new RangeError('timeoutMs must be non-negative');
    return { complete: !this.closed };
  }

  async close(timeoutMs: number): Promise<{ closed: boolean }> {
    if (timeoutMs < 0) throw new RangeError('timeoutMs must be non-negative');
    this.closed = true;
    return { closed: true };
  }
}

function sanitizeRecord(record: DiagnosticRecord): DiagnosticRecord {
  if (!record.component || !record.eventCode || record.safeMessage.length > 512) {
    throw productError({ code: 'LOG_RECORD_INVALID', category: 'logging', source: { component: 'logger', operation: 'write' }, safeMessage: 'A diagnostic record does not satisfy the logging contract', impactScope: 'call', recoveryAction: 'correct_input', correlation: {} });
  }
  const attrs = record.attributes ? Object.fromEntries(Object.entries(record.attributes).slice(0, 32).filter(([key, value]) => key.length <= 64 && !SECRET_KEY.test(key) && (typeof value === 'string' ? value.length <= 256 : true))) : undefined;
  const message = SECRET_KEY.test(record.safeMessage) ? '[redacted]' : record.safeMessage;
  // Even an empty sanitized object must replace the original secret attributes.
  return { ...record, safeMessage: message, ...(record.attributes ? { attributes: attrs ?? {} } : {}) };
}

export async function createLogger(input: { instanceId: string; processInstanceId: string; logRoot: string; config: LogConfig }): Promise<LoggerPort> {
  return new JsonlLogger(input);
}
