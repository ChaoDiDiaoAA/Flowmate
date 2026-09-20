import type { Id } from './foundation.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface DiagnosticRecord {
  level: LogLevel;
  component: string;
  eventCode: string;
  safeMessage: string;
  requestId?: Id;
  workspaceId?: Id;
  documentId?: Id;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface LogConfig {
  minLevel: LogLevel;
  maxRecordBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  retentionDays: number;
  queueLimit: number;
  flushTimeoutMs: number;
}

export interface LoggerPort {
  write(record: DiagnosticRecord): void;
  health(): { degraded: boolean; droppedRecords: number; reason?: string };
  flush(timeoutMs: number): Promise<{ complete: boolean }>;
  close(timeoutMs: number): Promise<{ closed: boolean }>;
}
