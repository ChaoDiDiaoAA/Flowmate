import type { CandidateRepository, ProductToolContext, Result, ToolCallContext } from '@flowmate/contracts';
import type { DocumentRepository, DocumentService } from '@flowmate/data';

export type InvoiceDocumentReader = {
  readParsedForRun(documentId: number, context: ProductToolContext): ReturnType<DocumentService['readParsedForRun']>
    | Promise<ReturnType<DocumentService['readParsedForRun']>>;
};
export type InvoiceDocumentRepository = {
  get(documentId: number): ReturnType<DocumentRepository['get']> | Promise<ReturnType<DocumentRepository['get']>>;
};
export type InvoiceCandidateRepository = {
  save(input: Parameters<CandidateRepository['save']>[0], call: ToolCallContext): ReturnType<CandidateRepository['save']>
    | Promise<ReturnType<CandidateRepository['save']>>;
  listForRun(input: Parameters<CandidateRepository['listForRun']>[0]): ReturnType<CandidateRepository['listForRun']>
    | Promise<ReturnType<CandidateRepository['listForRun']>>;
  readForRun(input: Parameters<CandidateRepository['readForRun']>[0]): ReturnType<CandidateRepository['readForRun']>
    | Promise<ReturnType<CandidateRepository['readForRun']>>;
};

export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.data;
}
