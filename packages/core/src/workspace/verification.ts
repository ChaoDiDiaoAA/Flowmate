import { appError, fail, ok, invoiceHeaderFields, invoiceLineFields } from '@flowmate/contracts';
import type { DocumentRef, Result, WorkspaceInput, WorkspaceMaterialInspection, WorkspaceSelection } from '@flowmate/contracts';

export type WorkspaceVerificationInput = {
  documentRef: DocumentRef | null;
  jobId: number | null;
  candidateRef: { id: number; sequence: number } | null;
  candidate: WorkspaceInput['candidate'];
  selection: WorkspaceSelection | null;
};
export type WorkspaceVerification = { invalidReferences: readonly string[]; material: WorkspaceMaterialInspection | null };
export type WorkspaceVerifier = (input: WorkspaceVerificationInput) => Result<WorkspaceVerification>;

export function createWorkspaceVerifier(options: {
  inspectMaterial(ref: DocumentRef): Result<WorkspaceMaterialInspection>;
}): WorkspaceVerifier {
  return input => {
    let material: WorkspaceMaterialInspection | null = null;
    const invalidReferences: string[] = [];
    if (input.documentRef !== null) {
      const inspected = options.inspectMaterial(input.documentRef);
      if (!inspected.ok) return inspected;
      material = inspected.data;
      if (material.kind === 'invalid') invalidReferences.push(material.reason);
      else {
        if (material.document.documentRef.id !== input.documentRef.id || material.document.documentRef.version !== input.documentRef.version)
          return fail(appError('storage_corrupt', 'storage', '材料核验返回了不同版本。'));
        if (material.document.isHidden) invalidReferences.push('document_hidden');
        if (material.document.status !== 'available') invalidReferences.push('document_unavailable');
      }
    }
    if ((input.candidateRef === null) !== (input.candidate === null) || input.candidate !== null &&
      (input.jobId === null || input.documentRef === null || input.candidate.id !== input.candidateRef?.id || input.candidate.sequence !== input.candidateRef.sequence))
      return fail(appError('storage_corrupt', 'storage', '候选权威引用无法核验。'));
    const selection = input.selection;
    if (selection !== null) {
      const target = selection.target === 'candidate' ? input.candidateRef : input.documentRef;
      if (!target || target.id !== selection.targetId) invalidReferences.push('selection_target_mismatch');
      else if ((selection.target === 'candidate' ? input.candidateRef?.sequence : input.documentRef?.version) !== selection.targetVersion)
        invalidReferences.push('selection_version_mismatch');
      else if (selection.kind === 'field' && selection.target === 'document') invalidReferences.push('selection_unsupported');
      else if (selection.kind === 'line') {
        if (!input.candidate || selection.lineIndex >= input.candidate.lines.length) invalidReferences.push('selection_location_missing');
      } else if (selection.kind === 'field' && selection.target === 'candidate') {
        const header = /^fields\.([A-Za-z]+)$/.exec(selection.fieldPath);
        const line = /^lines\.(0|[1-9]\d*)\.([A-Za-z]+)$/.exec(selection.fieldPath);
        if (header ? !invoiceHeaderFields.some(name => name === header[1]) : !line || !invoiceLineFields.some(name => name === line[2]))
          invalidReferences.push('selection_unsupported');
        else if (line && (!input.candidate || Number(line[1]) >= input.candidate.lines.length)) invalidReferences.push('selection_location_missing');
      } else if (selection.kind === 'source' && material?.kind === 'valid') {
        if (selection.artifactId !== material.document.parsedArtifactId) invalidReferences.push('selection_target_mismatch');
        else {
          const pages = material.pages.filter(page => selection.page === undefined || page.page === selection.page);
          const matches = selection.block === undefined ? pages.length : pages.filter(page => page.blockIds.includes(selection.block!)).length;
          if (matches !== 1) invalidReferences.push('selection_location_missing');
        }
      }
    }
    return ok({ invalidReferences: [...new Set(invalidReferences)], material });
  };
}

/** A successful inspection with invalid facts is diagnostic evidence, never admission. */
export function requireValidWorkspace(verification: WorkspaceVerification): Result<void> {
  const reasons = verification.invalidReferences;
  if (reasons.some(reason => reason.startsWith('selection_'))) return fail(appError('selection_invalid', 'input', '选择定位已失效，请重新选择。'));
  if (reasons.includes('document_version_mismatch')) return fail(appError('state_conflict', 'input', '材料版本已变化，请重新读取。', true));
  if (reasons.some(reason => reason.startsWith('document_') || reason.startsWith('artifact_')) ||
    verification.material?.kind === 'valid' && verification.material.document.status !== 'available')
    return fail(appError('input_unavailable', 'input', '材料当前不可用于现场操作。', true));
  return reasons.length ? fail(appError('state_conflict', 'input', 'Workspace 引用已变化，请重新读取。', true)) : ok(undefined);
}

export function sameWorkspaceSelection(a: WorkspaceSelection | null, b: WorkspaceSelection | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.formatVersion !== b.formatVersion || a.kind !== b.kind || a.target !== b.target || a.targetId !== b.targetId || a.targetVersion !== b.targetVersion) return false;
  if (a.kind === 'field' && b.kind === 'field') return a.fieldPath === b.fieldPath;
  if (a.kind === 'line' && b.kind === 'line') return a.lineIndex === b.lineIndex;
  return a.kind === 'source' && b.kind === 'source' && a.artifactId === b.artifactId && a.page === b.page && a.block === b.block;
}
