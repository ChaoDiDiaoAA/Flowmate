import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export class EvaluationWriteConflict extends Error {
    readonly code = 'evaluation_write_conflict';
    constructor() { super('Evaluation write conflict: the sidecar is occupied or its previous owner requires verification'); }
}

export function acquireEvaluationWrite(file: string): () => void {
    const parent = dirname(resolve(file)), lock = resolve(file) + '.write-lock';
    const target = lstatSync(file, { throwIfNoEntry: false });
    if (realpathSync(parent).toLowerCase() !== parent.toLowerCase() || target && (!target.isFile() || target.isSymbolicLink()))
        throw Error('Linked or invalid evaluation write target rejected');
    const owner = JSON.stringify({ version: 'flowmate-eval-write/v1', target: resolve(file), pid: process.pid, ownerId: randomUUID() }) + '\n';
    let fd: number;
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error && ['EEXIST', 'EISDIR'].includes(String(error.code))) throw new EvaluationWriteConflict();
        throw error;
    }
    try { writeFileSync(fd, owner); fsyncSync(fd); }
    catch (error) {
        closeSync(fd);
        if (!lstatSync(lock).isSymbolicLink() && readFileSync(lock, 'utf8') === owner) unlinkSync(lock);
        throw error;
    }
    closeSync(fd);
    let released = false;
    return () => {
        if (released) return;
        // Occupied or leftover markers are never reclaimed by time or PID guesses.
        if (lstatSync(lock, { throwIfNoEntry: false })?.isSymbolicLink() || readFileSync(lock, 'utf8') !== owner)
            throw Error('Evaluation write ownership changed; refusing to release another writer');
        unlinkSync(lock); released = true;
    };
}

export function atomicText(file: string, value: string) {
    if(realpathSync(dirname(file)).toLowerCase()!==resolve(dirname(file)).toLowerCase()||lstatSync(file,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('Linked output path rejected');
    const temporary=file+'.'+randomUUID()+'.tmp';let fd:number|undefined;
    try {fd=openSync(temporary,'wx',0o600);writeFileSync(fd,value);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temporary,file);}
    finally {if(fd!==undefined)closeSync(fd);if(existsSync(temporary))unlinkSync(temporary);}
}

export function readableTimestamp(date = new Date()) {
    const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(date);
    return parts.replace(' ', '_').replaceAll(':', '');
}
