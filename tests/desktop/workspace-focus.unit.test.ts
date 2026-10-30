import { expect, test } from 'bun:test';
import * as workspace from '../../apps/desktop/renderer/src/workspace-state.ts';

test('restores only a validated page and research identity and tolerates unavailable navigation storage', () => {
  let stored: string | null = null;
  const storage = { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } };
  expect(workspace.readWorkspaceFocus(storage)).toBeNull();
  expect(workspace.saveWorkspaceFocus(storage, { page: 'research', researchId: 7 })).toBe(true);
  expect(workspace.readWorkspaceFocus(storage)).toEqual({ page: 'research', researchId: 7 });
  stored = '{"page":"research","researchId":-1}';
  expect(workspace.readWorkspaceFocus(storage)).toBeNull();
  stored = '{"page":"research","researchId":7,"documentText":"unselected"}';
  expect(workspace.readWorkspaceFocus(storage)).toBeNull();
  expect(workspace.readWorkspaceFocus({ getItem() { throw Error('unavailable'); } })).toBeNull();
  expect(workspace.saveWorkspaceFocus({ setItem() { throw Error('unavailable'); } }, { page: 'workspace' })).toBe(false);
});
