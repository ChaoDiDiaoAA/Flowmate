import type { SynchronousDatabaseExecutor } from './write-coordinator.ts';

export type ManagedFileOwner = { ownerKind: string; ownerId: string; relativePath: string };
export type ManagedFileContents = {
  read(owner: ManagedFileOwner): Uint8Array | null;
  remember(owner: ManagedFileOwner, content: Uint8Array): void;
};

export function createManagedFileContents(db: SynchronousDatabaseExecutor): ManagedFileContents {
  const identity = (owner: ManagedFileOwner) => {
    if (!owner.ownerKind || !owner.ownerId || !owner.relativePath || owner.relativePath.startsWith('/')
      || owner.relativePath.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part)))
      throw new Error('managed_file_identity_invalid');
    return [owner.ownerKind, owner.ownerId, owner.relativePath] as const;
  };
  const read = (owner: ManagedFileOwner): Uint8Array | null => {
    const row = db.query('SELECT content FROM managed_file_contents WHERE owner_kind=? AND owner_id=? AND relative_path=?')
      .get(...identity(owner)) as { content: Uint8Array } | null;
    return row ? Uint8Array.from(row.content) : null;
  };
  return { read, remember(owner, content) {
    if (!(content instanceof Uint8Array)) throw new Error('managed_file_content_invalid');
    db.transaction(() => {
      const before = read(owner);
      if (before) {
        if (!Buffer.from(before).equals(Buffer.from(content))) throw new Error('managed_file_content_conflict');
        return;
      }
      db.query('INSERT INTO managed_file_contents(owner_kind,owner_id,relative_path,content) VALUES(?,?,?,?)')
        .run(...identity(owner), content);
    }).immediate();
  } };
}
