import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LangfuseClient } from '@langfuse/client';
import { loadCases, projectCaseInput, selectCases } from '../datasets/load.ts';
import type { CaseDefinition, EvaluationMode, ProjectedInput } from '../types.ts';

export const P1_DATASET_URL = new URL('../../stage-evals/P1/v1/cases.json', import.meta.url);
export const P1_DATASET_ROOT = dirname(fileURLToPath(P1_DATASET_URL));

export function datasetName(stage: string, mode: EvaluationMode): string {
  return `flowmate/${stage}/v1/${mode}`;
}

function contentHash(caseData: CaseDefinition): string {
  return createHash('sha256').update(JSON.stringify(caseData)).digest('hex');
}

function stableItemId(name: string, caseData: CaseDefinition): string {
  const hex = createHash('sha256').update(`${name}:${caseData.id}:${caseData.version}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type LangfuseCaseLabel = {
  id: string;
  version: number;
  name: string;
  capability: string;
  relatedCapabilities: string[];
};

export type LangfuseDatasetItem = {
  id: string;
  datasetName: string;
  input: { case: LangfuseCaseLabel; modelInput: ProjectedInput };
  expectedOutput: CaseDefinition['expected'];
  metadata: {
    caseId: string;
    caseVersion: number;
    caseName: string;
    caseLabel: string;
    capability: string;
    relatedCapabilities: string[];
    stage: string;
    mode: EvaluationMode;
    split: string;
    contentHash: string;
    projectionVersion: 2;
  };
};

export function caseLabel(caseData: CaseDefinition): LangfuseCaseLabel {
  return {
    id: caseData.id,
    version: caseData.version,
    name: caseData.name,
    capability: caseData.capability,
    relatedCapabilities: caseData.related_capabilities,
  };
}

/**
 * Langfuse receives a human-readable case label and the separately projected
 * user input. The product invocation continues to receive only modelInput.
 */
export function createLangfuseDatasetItem(
  name: string,
  stage: string,
  mode: EvaluationMode,
  caseData: CaseDefinition,
): LangfuseDatasetItem {
  const label = caseLabel(caseData);
  return {
    id: stableItemId(name, caseData),
    datasetName: name,
    input: { case: label, modelInput: projectCaseInput(caseData, P1_DATASET_ROOT) },
    expectedOutput: caseData.expected,
    metadata: {
      caseId: caseData.id,
      caseVersion: caseData.version,
      caseName: caseData.name,
      caseLabel: `${caseData.id}/v${caseData.version} | ${caseData.name}`,
      capability: caseData.capability,
      relatedCapabilities: caseData.related_capabilities,
      stage,
      mode,
      split: caseData.split,
      contentHash: contentHash(caseData),
      projectionVersion: 2,
    },
  };
}

function isAlreadyExists(error: unknown): boolean {
  const value = error as { statusCode?: number; status?: number; message?: string };
  return value.statusCode === 409 || value.status === 409 || /already exists|conflict/i.test(value.message ?? '');
}

export async function syncStage(client: LangfuseClient, stage = 'P1'): Promise<Array<{ dataset: string; items: number }>> {
  const cases = loadCases(P1_DATASET_URL);
  const summaries: Array<{ dataset: string; items: number }> = [];
  for (const mode of ['fixture', 'live'] as const) {
    const name = datasetName(stage, mode);
    try {
      await client.api.datasets.create({ name, description: `${stage} ${mode} evaluation cases, contract version 1`, metadata: { stage, version: 1, mode } });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    let existing = await client.dataset.get(name);
    const selected = selectCases(cases, stage, mode);
    for (const caseData of selected) {
      const item = createLangfuseDatasetItem(name, stage, mode, caseData);
      const prior = existing.items.find((existingItem) => existingItem.id === item.id);
      const priorHash = (prior?.metadata as { contentHash?: string } | undefined)?.contentHash;
      if (prior && priorHash && priorHash !== item.metadata.contentHash) {
        throw new Error(`Dataset conflict for ${caseData.id}/v${caseData.version}; bump the case version before changing content`);
      }
      await client.dataset.createItem(item);
    }
    existing = await client.dataset.get(name);
    summaries.push({ dataset: name, items: existing.items.length });
  }
  return summaries;
}

export function loadLocalP1Cases(): CaseDefinition[] {
  return loadCases(P1_DATASET_URL);
}
