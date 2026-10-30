import { bootstrapDatabase } from './bootstrap.ts';
import { appError, fail, ok } from '@flowmate/contracts';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { validateProductPaths } from '@flowmate/shared';
import type { AppError, MemoryStore, ProductPaths, Result } from '@flowmate/contracts';
import type { ManagedFileContents } from './managed-file-contents.ts';
import type { DatabaseCoordinator, SynchronousDatabaseExecutor } from './write-coordinator.ts';
import type { SessionInputLedger } from '../sessions/input-ledger.ts';
import type { RuntimeEventStore } from '../events/store.ts';
import type { EventService } from '../events/service.ts';
import type { ContextRepository } from '../context/repository.ts';
import type { ResearchRepository } from '../research/repository.ts';
import type { InvoiceWorkRepository, PersonalAgentRepository } from '../personal-agent/repository.ts';
import type { InvoiceWorkContextRepository } from '../personal-agent/context-repository.ts';
import type { InvoiceWorkAttemptRepository } from '../personal-agent/attempts.ts';
import type { InvoiceWorkModelBindingRepository } from '../personal-agent/model-bindings.ts';
import type { DocumentRepository, ToolCallRepository, BusinessEventRepository, JobRepository, RunRepository,
  SessionRepository, WorkspaceRepository, InvoiceEditRepository } from './repositories.ts';

export type SqlDatabaseStore = {
  db: SynchronousDatabaseExecutor;
  memory: Pick<MemoryStore, 'load' | 'commit'>;
  runs: RunRepository;
  sessions: SessionRepository;
  sessionInputs: SessionInputLedger;
  documents: DocumentRepository;
  contents: ManagedFileContents;
  workspace: WorkspaceRepository;
  jobs: JobRepository;
  toolCalls: ToolCallRepository;
  businessEvents: BusinessEventRepository;
  candidates: InvoiceEditRepository;
  context: ContextRepository;
  research: ResearchRepository;
  personalAgents: PersonalAgentRepository;
  invoiceWorks: InvoiceWorkRepository;
  invoiceWorkContexts: InvoiceWorkContextRepository;
  invoiceWorkAttempts: InvoiceWorkAttemptRepository;
  invoiceWorkModelBindings: InvoiceWorkModelBindingRepository;
  runtimeEventStore: RuntimeEventStore;
};

export type DbHandle = {
  coordinator: Pick<DatabaseCoordinator, 'read' | 'transaction'>;
  read<T>(operation: (store: SqlDatabaseStore) => T | Promise<T>): Promise<T>;
  transaction<T>(operation: (store: SqlDatabaseStore) => T | Promise<T>): Promise<T>;
  runtimeEvents: EventService;
  /** Required historical stop gaps; diagnostics and Session-local history do not poison this root. */
  recoveryError: AppError | null;
  /** Run identities that predate this database owner's in-memory diagnostics. */
  maxRunIdAtBoot: number;
  close: () => Promise<void>;
};

export function openDatabase(paths: ProductPaths): Result<DbHandle> {
  const validated = validateProductPaths(paths); if (!validated.ok) return validated;
  let pendingRestore = true;
  try { lstatSync(join(paths.root, 'data/service-restore.json')); }
  catch (cause) { if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') pendingRestore = false; }
  if (pendingRestore) return fail(appError('maintenance_restore_pending', 'storage',
    'The original service data restore is unfinished. Resume the same backup and finish publication before opening the product database.', true));
  const opened = bootstrapDatabase(paths);
  return opened.ok ? ok(opened.data.owner) : opened;
}
