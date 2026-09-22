import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { TrialContext } from '../types.ts';

const SAFE_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafePart(label: string, value: string): void {
  if (!SAFE_PART.test(value)) throw new Error(`${label} contains unsafe path characters`);
}

function assertInside(base: string, target: string): void {
  const rel = relative(base, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Trial root escapes the configured base root');
}

export function prepareTrial(input: { baseRoot: string; executionId: string; caseId: string; trialIndex: number }): TrialContext {
  if (!isAbsolute(input.baseRoot)) throw new Error('Trial baseRoot must be absolute');
  if (!Number.isInteger(input.trialIndex) || input.trialIndex < 1) throw new Error('trialIndex must be a positive integer');
  assertSafePart('executionId', input.executionId);
  assertSafePart('caseId', input.caseId);
  mkdirSync(input.baseRoot, { recursive: true });
  const base = realpathSync(input.baseRoot);
  const trialId = `trial-${input.trialIndex}`;
  // Callers provide an execution-scoped base root. Keeping the execution ID
  // out of this path avoids a duplicated `<executionId>/<executionId>` layer
  // while the owner marker still binds the Trial to that execution.
  const root = resolve(base, input.caseId, trialId);
  assertInside(base, root);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) throw new Error('Trial root cannot be a symbolic link or junction');
  for (const part of ['data', 'logs', 'artifacts', 'outputs', 'runtime']) mkdirSync(join(root, part), { recursive: true });
  const owner = { version: 1 as const, executionId: input.executionId, trialId, root };
  const marker = join(root, '.flowmate-trial-owner.json');
  if (existsSync(marker)) {
    const current = JSON.parse(readFileSync(marker, 'utf8')) as typeof owner;
    if (current.executionId !== owner.executionId || current.trialId !== owner.trialId || current.root !== owner.root) {
      throw new Error('Trial root owner does not match this execution');
    }
  } else {
    writeFileSync(marker, `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
  }
  return {
    executionId: input.executionId,
    trialId,
    caseId: input.caseId,
    owner,
    paths: {
      root,
      databaseFile: join(root, 'data', `${trialId}.sqlite`),
      logsDir: join(root, 'logs'),
      artifactsDir: join(root, 'artifacts'),
      outputsDir: join(root, 'outputs'),
      runtimeDir: join(root, 'runtime'),
    },
  };
}
