import { expect, it } from 'bun:test';
import { ok, type ResourceSelection } from '@flowmate/contracts';
import { researchFixture, researchPlan, researchNeed as need } from '../../support/research.ts';

it('freezes research resources independently of the global invoice selection', async () => {
  let selection: ResourceSelection = { prompt: null, enabledSkills: [] };
  const f = await researchFixture((_request, index) => index === 1
    ? { tool: 'save_research_plan', args: researchPlan, id: 'plan' } : { text: 'Confirm this plan.' }, undefined,
  { resourceDefaults: () => ok({ revision: 7, selection, extensions: { enabledExtensions: [] } }) });
  const catalog = need(await f.app.listResources());
  const invoice = catalog.items.find(item => item.ref.kind === 'prompt' && item.ref.id !== 'research' && item.available)!;
  expect(invoice).toBeDefined(); selection = { prompt: invoice.ref, enabledSkills: [] };
  const result = await f.run(f.request(1));
  const resources = need(await f.app.queryRun(result.accepted.runId)).config.resources as any;
  expect(resources.prompt?.ref?.id ?? resources.prompt?.id).toBe('research');
  expect(resources.selectedSkills.map((ref: { id: string }) => ref.id)).toEqual(['deep-research']);
  expect(selection.prompt).toEqual(invoice.ref);
  expect(need(await f.app.queryResearchTask(f.task.researchId)).status).toBe('awaiting_confirmation');
});
