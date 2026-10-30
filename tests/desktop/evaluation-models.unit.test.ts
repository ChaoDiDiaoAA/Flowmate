import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvaluationModels } from '../../apps/desktop/renderer/src/evaluation-models.tsx';

test('native Judge settings expose executable and effort without an HTTP key field', () => {
  const html = renderToStaticMarkup(createElement(EvaluationModels, { revision: 1, ready: true, onSaved: async () => {},
    settings: { agent: null, judge: { provider: 'codex-cli', executable: 'codex', model: 'gpt-6.1-terra', reasoningEffort: 'medium', timeoutMs: 180000 } },
    credentials: { agent: 'missing', judge: 'configured' } }));
  const judge = html.slice(html.indexOf('aria-label="Evaluation Judge settings"'));
  expect(judge).toContain('Codex CLI'); expect(judge).toContain('Executable'); expect(judge).toContain('Reasoning effort');
  expect(judge).not.toContain('API key'); expect(judge).not.toContain('Base URL');
  expect(judge).toContain('Native login');
});
