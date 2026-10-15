import { linkSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { appError, fail, ok } from '@flowmate/contracts';
import type { Result } from '@flowmate/contracts';

export function publishExportCopy(destinationPath: string, bytes: Uint8Array): Result<{ destinationPath: string; bytes: number }> {
  if (!isAbsolute(destinationPath) || bytes.byteLength < 1 || bytes.byteLength > 64 * 1024 * 1024)
    return fail(appError('input_invalid', 'input', 'The export destination or size is invalid.'));
  const matches = () => {
    const stat = lstatSync(destinationPath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === bytes.byteLength && readFileSync(destinationPath).equals(Buffer.from(bytes));
  };
  const conflict = () => fail(appError('state_conflict', 'input', 'The destination contains different content or is not a regular file. Choose another filename.'));
  let temporary: string | null = null;
  try {
    try {
      lstatSync(destinationPath);
      if (!matches()) return conflict();
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      temporary = join(dirname(destinationPath), `.flowmate-export-${randomUUID()}.tmp`);
      writeFileSync(temporary, bytes, { flag: 'wx' });
      if (!readFileSync(temporary).equals(Buffer.from(bytes))) throw new Error('export_copy_check_failed');
      try { linkSync(temporary, destinationPath); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        if (!matches()) return conflict();
      }
    }
    if (!matches()) throw new Error('export_destination_changed');
    return ok({ destinationPath, bytes: bytes.byteLength });
  } catch { return fail(appError('storage_write_failed', 'storage', 'The external copy could not be confirmed. The managed export and any published copy are retained for inspection.', true)); }
  finally { if (temporary !== null) try { rmSync(temporary); } catch { /* Keep the publication result. */ } }
}
export const publishInvoiceExportCopy = publishExportCopy;
