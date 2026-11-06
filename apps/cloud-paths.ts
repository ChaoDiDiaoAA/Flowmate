import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';

/** Untrusted users must not be able to replace a protected service directory. */
export function safeCloudAncestors(directory: string, owner: number): boolean {
  try {
    for (let current = dirname(directory); ; current = dirname(current)) {
      const item = lstatSync(current);
      if (!item.isDirectory() || item.isSymbolicLink() || item.uid !== 0 && item.uid !== owner
        || (item.mode & 0o022) !== 0 && (item.mode & 0o1000) === 0) return false;
      if (dirname(current) === current) return true;
    }
  } catch { return false; }
}
