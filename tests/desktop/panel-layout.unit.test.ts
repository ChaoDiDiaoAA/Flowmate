import { expect, test } from 'bun:test';
import { DEFAULT_PANEL_WIDTHS, fitPanelWidths, parsePanelWidths } from '../../apps/desktop/renderer/src/panel-layout.tsx';
import { skillIntroduction } from '../../apps/desktop/renderer/src/skill-introductions.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';

test('all seventeen builtin introductions are English while an unknown or changed description keeps its meaning', () => {
  const root = resolve(import.meta.dirname, '../../resources/skills');
  const descriptions = readdirSync(root).map(id => parseFrontmatter<{ description: string }>(readFileSync(join(root, id, 'SKILL.md'), 'utf8')).frontmatter.description);
  expect(descriptions).toHaveLength(17);
  for (const description of descriptions) expect(skillIntroduction(description)).not.toMatch(/[\u3400-\u9fff]/u);
  const changed = '同一名称的新介绍不应套用旧译文。';
  expect(skillIntroduction(changed)).toBe(changed);
});

test('panel preferences reject malformed and invalid widths without interpreting other settings', () => {
  for (const value of [null, '{broken', 'null', '[]', '{}', '{"sidebar":199,"assistant":380}',
    '{"sidebar":240,"assistant":299}', '{"sidebar":"240","assistant":380}', '{"sidebar":1e300,"assistant":380}'])
    expect(parsePanelWidths(value)).toEqual(DEFAULT_PANEL_WIDTHS);
  expect(parsePanelWidths('{"sidebar":300,"assistant":560}')).toEqual({ sidebar: 300, assistant: 560 });
});

test('fitting shrinks Assistant first, preserves center and original preferences, and respects responsive modes', () => {
  const preferred = Object.freeze({ sidebar: 500, assistant: 600 });
  expect(fitPanelWidths(preferred, 1500, false)).toEqual(preferred);
  expect(fitPanelWidths(preferred, 1200, false)).toEqual({ sidebar: 500, assistant: 340 });
  expect(fitPanelWidths({ sidebar: 900, assistant: 900 }, 1200, false)).toEqual({ sidebar: 540, assistant: 300 });
  expect(fitPanelWidths({ sidebar: 500, assistant: 900 }, 1100, false)).toEqual({ sidebar: 64, assistant: 676 });
  expect(fitPanelWidths(preferred, 1199, true)).toEqual({ sidebar: 64, assistant: 44 });
  expect(fitPanelWidths(preferred, 1200, true)).toEqual({ sidebar: 500, assistant: 44 });
  expect(fitPanelWidths(preferred, 980, false)).toEqual({ sidebar: 64, assistant: 380 });
  expect(preferred).toEqual({ sidebar: 500, assistant: 600 });
  expect(fitPanelWidths(preferred, 1500, false)).toEqual(preferred);
});
