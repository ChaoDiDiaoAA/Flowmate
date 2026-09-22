import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { CaseDefinition, EvaluationMode, ProjectedInput } from '../types.ts';

function assertInside(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Case document must be a file below the dataset root: ${target}`);
  }
}

export function loadCases(path: URL): CaseDefinition[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('cases.json must contain a JSON array');
  const cases = parsed as CaseDefinition[];
  const identities = new Set<string>();
  for (const item of cases) {
    if (!item.id || !Number.isInteger(item.version) || !item.stage || !item.input?.goal) {
      throw new Error('Every case requires id, integer version, stage and input.goal');
    }
    const identity = `${item.id}/${item.version}`;
    if (identities.has(identity)) throw new Error(`Duplicate case identity: ${identity}`);
    identities.add(identity);
  }
  return cases;
}

export function selectCases(cases: CaseDefinition[], stage: string, mode: EvaluationMode): CaseDefinition[] {
  return cases.filter((item) => item.stage === stage && item.input.setup.allowed_modes?.includes(mode));
}

export function projectCaseInput(caseData: CaseDefinition, assetRoot: string): ProjectedInput {
  const root = realpathSync(assetRoot);
  const documents = caseData.input.documents.map((documentPath) => {
    const absolute = resolve(root, documentPath);
    assertInside(root, absolute);
    const real = realpathSync(absolute);
    assertInside(root, real);
    const text = readFileSync(real, 'utf8');
    return { path: documentPath, sha256: createHash('sha256').update(text).digest('hex'), text };
  });
  return {
    goal: caseData.input.goal,
    text: documents.map((item) => item.text).join('\n\n'),
    documents,
  };
}

export function datasetRootForCases(path: URL): string {
  return dirname(path.pathname);
}
