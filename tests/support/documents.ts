import type { FileStore } from '../../packages/core/src/storage/file-store.ts';
import { createDocumentService } from '../../packages/data/src/documents.ts';
import type { DocumentService, DocumentServiceOptions, MaterialInspectionOptions } from '../../packages/data/src/documents.ts';
import type { SqlDatabaseStore } from '../../packages/core/src/storage/database.ts';
import type { TestDbHandle } from './database.ts';

/** Component fixtures bind their actual repositories explicitly; public service calls retain the real owner. */
export function createTestDocumentService(options: Omit<DocumentServiceOptions, 'files' | 'transaction'> & {
  files: Pick<FileStore, 'publish' | 'read'>; inspection?: MaterialInspectionOptions;
}, database: TestDbHandle) {
  const bind = (scope: Pick<SqlDatabaseStore, 'documents' | 'contents'>): MaterialInspectionOptions => ({
    repository: scope.documents, files: { read: (artifact, name) => options.files.read(artifact, name, scope.contents) },
  });
  const service = createDocumentService({ paths: options.paths, allowedSourceRoot: options.allowedSourceRoot,
    files: options.files, now: options.now, transaction: operation => database.transaction(scope => operation(bind(scope))) });
  const inspection = options.inspection ?? bind(database);
  return {
    importPrepared: service.importPrepared.bind(service), importVoxel51: service.importVoxel51.bind(service),
    readOriginalForWorkspace: service.readOriginalForWorkspace.bind(service), restoreDocument: service.restoreDocument.bind(service),
    readParsedForRun: (id: number, context: Parameters<DocumentService['readParsedForRun']>[1], current = inspection) => service.readParsedForRun(id, context, current),
    readParsedForWorkspace: (id: number, current = inspection) => service.readParsedForWorkspace(id, current),
    inspectForWorkspace: (ref: Parameters<DocumentService['inspectForWorkspace']>[0], current = inspection) => service.inspectForWorkspace(ref, current),
    inspectParsedForContext: (input: Parameters<DocumentService['inspectParsedForContext']>[0], current = inspection) => service.inspectParsedForContext(input, current),
  };
}
