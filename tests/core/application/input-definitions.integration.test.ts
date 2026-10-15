import { afterEach, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInputDefinitions } from '../../../packages/core/src/prompt-templates.ts';
import { parseFrontmatter, loadPromptTemplates, expandPromptTemplate } from '@earendil-works/pi-coding-agent';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it('freezes roles and native template expansion, and writes overrides with compare-and-swap', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-definitions-')); roots.push(root);
  for (const path of ['resources/subagents', 'resources/prompt-templates', 'runtime']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'resources/subagents/analyst.md'), '---\nname: analyst\ndescription: Independent analysis\ntools: []\n---\nAnalyze without tools.');
  writeFileSync(join(root, 'resources/prompt-templates/review.md'), '---\ndescription: Review with a delegate\n---\nReview $1 with $ARGUMENTS.');
  const service = createInputDefinitions({ resourceRoot: join(root, 'resources'), runtimeRoot: join(root, 'runtime'),
    tools: [], parseFrontmatter, loadPromptTemplates, expandPromptTemplate });
  const first = service.listSubagentDefinitions(); expect(first.ok).toBe(true);
  if (!first.ok) return;
  const role = first.data[0]!;
  const expanded = service.freeze('/review "two words" tail'); expect(expanded.ok && expanded.data.command?.expandedText).toBe('Review two words with two words tail.');
  expect(service.freeze('/unknown').ok).toBe(false);
  expect(service.saveSubagentDefinition({ id: role.id, expectedContent: 'Stale content', content: role.content }).ok).toBe(false);
  expect(service.saveSubagentDefinition({ id: role.id, expectedContent: role.content, content: role.content.replace('Analyze without tools.', 'Analyze independently.') }).ok).toBe(true);
  const changed = service.getSubagentDefinition({ id: role.id }); expect(changed.ok && changed.data.source).toBe('user');
  expect(role.systemPrompt).toBe('Analyze without tools.');
  const delegated = service.freeze('/subagent analyst find contradictions'); expect(delegated.ok && delegated.data.command?.requiredRoles).toEqual(['analyst']);
  expect(service.saveSubagentDefinition({ id: 'writer', expectedContent: null,
    content: '---\nname: writer\ndescription: Write\ntools: [write]\n---\nWrite.' }).ok).toBe(false);
});

it('rejects a 65th effective role before saving and recovers interrupted owned staging files', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-role-capacity-')); roots.push(root);
  for (const path of ['resources/subagents', 'runtime/subagents']) mkdirSync(join(root, path), { recursive: true });
  for (let index = 0; index < 64; index++) writeFileSync(join(root, `resources/subagents/analyst-${index}.md`),
    `---\nname: analyst-${index}\ndescription: Independent analysis\ntools: []\n---\nAnalyze without tools.`);
  const service = createInputDefinitions({ resourceRoot: join(root, 'resources'), runtimeRoot: join(root, 'runtime'),
    tools: [], parseFrontmatter, loadPromptTemplates, expandPromptTemplate });
  const before = service.listSubagentDefinitions(); if (!before.ok) throw Error(before.error.code);
  expect(service.saveSubagentDefinition({ id: 'extra', expectedContent: null,
    content: '---\nname: extra\ndescription: Extra analysis\ntools: []\n---\nAnalyze.' }).ok).toBe(false);
  expect(service.saveSubagentDefinition({ id: before.data[0]!.id, expectedContent: before.data[0]!.content,
    content: before.data[0]!.content.replace('without tools', 'independently') }).ok).toBe(true);
  writeFileSync(join(root, 'runtime/subagents/.b438343e-0a15-4c9b-a59c-4066d14c1eef.tmp'), 'interrupted old staging');
  writeFileSync(join(root, 'runtime/.subagent-b438343e-0a15-4c9b-a59c-4066d14c1eef.tmp'), 'interrupted staging');
  expect(service.listSubagentDefinitions()).toMatchObject({ ok: true, data: expect.arrayContaining([expect.objectContaining({ source: 'user' })]) });
  expect(service.freeze('ordinary chat').ok).toBe(true);
});
