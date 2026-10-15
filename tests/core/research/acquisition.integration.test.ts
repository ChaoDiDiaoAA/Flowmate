import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';

it('captures selected local material via SDK, Executor and Recorder, preserving actual source execution', async () => {
  const body = 'Deployment cost depends on actual usage. 原文';
  const f = await researchFixture((_request, index) => index === 1 ? { tool: 'save_research_plan', args: { ...researchPlan, sourcePolicy: f.task.sourcePolicy }, id: 'plan' }
    : index === 3 ? { tool: 'read_research_local', args: { artifactId: f.task.sourcePolicy.artifactIds[0], documentId: null }, id: 'read' }
    : { text: 'This fixture preserves evidence and leaves version-specific conditions unresolved.' }, undefined, { material: body });
  await f.run(f.request(1)); expect(need(await f.app.listResearchSources({ researchId: f.task.researchId })).items).toEqual([]);
  const task = need(await f.app.queryResearchTask(f.task.researchId)), plan = need(await f.app.queryResearchPlan({ researchId: task.researchId, planId: task.currentPlanId! }));
  const investigation = await f.run(f.request(2, { researchId: task.researchId, phase: 'researching', plan: { planId: plan.planId, revision: plan.revision } }));
  const sources = need(await f.app.listResearchSources({ researchId: task.researchId })).items;
  expect(sources).toHaveLength(1);
  const source = sources[0]!;
  expect(source.runId).toBe(investigation.accepted.runId); expect(source.kind).toBe('local');
  expect(readFileSync(join(f.paths.root, source.relativePath), 'utf8')).toBe(body);
  expect(source.characters).toBe(body.length); expect(source.truncated).toBe(false);
  const receipt=JSON.parse(String(f.requests[3]!.messages.filter(m=>m.role==='tool').at(-1)!.content));
  expect(receipt.evidenceRef).toMatchObject({researchId:task.researchId,planId:plan.planId,revision:plan.revision,
    runId:source.runId,toolCallId:source.toolCallId,sourceSnapshotId:source.sourceSnapshotId,locator:{start:0,end:body.length,quote:body}});
  expect(JSON.stringify(f.requests[3]!.messages)).toContain(body);
  for (const request of f.requests) {
    expect(request.tools?.map(tool => tool.function.name)).not.toContain('search_research_sources');
    expect(request.tools?.map(tool => tool.function.name)).not.toContain('read_research_web');
  }
  need(await f.app.close());
  const db = new Database(f.paths.databaseFile, { readonly: true });
  try {
    expect(db.query('SELECT run_id,tool_name,status FROM tool_calls WHERE id=?').get(source.toolCallId))
      .toEqual({ run_id: source.runId, tool_name: 'read_research_local', status: 'succeeded' });

  }
  finally { db.close(); }
});
