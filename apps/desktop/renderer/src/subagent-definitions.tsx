import { useEffect, useState } from 'react';
import type { SubagentDefinition } from '@flowmate/contracts';
import { useRead } from './context-state.ts';

export function SubagentDefinitions({ hostEpoch, ready }: { hostEpoch: number; ready: boolean }) {
  const identity = { hostEpoch, sessionId: 0, runId: null, selectionToken: 0 };
  const list = useRead<SubagentDefinition[]>(identity), saving = useRead<SubagentDefinition>(identity);
  const [id, setId] = useState(''), [content, setContent] = useState('');
  const [expectedContent, setExpectedContent] = useState<string | null>(null), [editing, setEditing] = useState(false);
  const [recovery, setRecovery] = useState(false), [notice, setNotice] = useState('');
  async function refresh() { if (ready) await list.read('agents', () => window.flowmate.listSubagentDefinitions(), () => true); }
  useEffect(() => { void refresh(); }, [hostEpoch, ready]);
  function select(role?: SubagentDefinition) {
    setId(role?.id ?? ''); setExpectedContent(role?.content ?? null); setRecovery(false); setNotice(''); setEditing(!!role);
    setContent(role?.content ?? '---\nname: new-agent\ndescription: Describe when to delegate to this agent.\ntools: []\n---\nAnalyze the assigned task independently. Return findings and uncertainties.');
  }
  async function save() {
    if (!ready || recovery || saving.state.pending) return;
    const result = await saving.read('save:'+id, () => window.flowmate.saveSubagentDefinition({ id, expectedContent, content }),
      value => value.id === id && value.content === content);
    if (result) { setExpectedContent(result.content); setEditing(true); setNotice('Saved. Changes apply to future Runs.'); await refresh(); }
    else { setRecovery(true); setNotice('The save was not confirmed. Your draft is retained. Check the saved definition before retrying.'); }
  }
  async function recover() {
    const result = await saving.read('query:'+id, () => window.flowmate.getSubagentDefinition({ id }), value => value.id === id);
    if (result) { setExpectedContent(result.content); setEditing(true); setRecovery(false);
      setNotice(result.content === content ? 'The original save is confirmed.' : 'Loaded the current identity. Your draft is retained; review it before saving.'); await refresh(); }
    else {
      const current = await list.read('recover-agents', () => window.flowmate.listSubagentDefinitions(), () => true);
      if (current && !current.some(role => role.id === id)) { setExpectedContent(null); setEditing(false); setRecovery(false);
        setNotice('No saved definition exists for this ID. Your draft is retained.'); }
    }
  }
  return <section className="panel agent-definitions" aria-label="Subagent definitions">
    <div className="panel-head"><h2>Manage agents</h2><button type="button" className="secondary-button" disabled={!ready || saving.state.pending}
      onClick={() => select()}>New agent</button></div>
    <p>Roles share the Pi SDK loop and use only declared read-only tools permitted by their parent Run. Editing a built-in role creates a user override.</p>
    {[list.state.error, saving.state.error].filter(Boolean).map((error, index) => <p role="alert" key={index}>{error}</p>)}
    <div className="button-row">{list.state.data?.map(role => <button className="secondary-button" type="button" key={role.id}
      disabled={saving.state.pending} onClick={() => select(role)}>{role.id} · {role.source}</button>)}</div>
    <label className="field">Agent ID<input value={id} disabled={editing || saving.state.pending} onChange={event => setId(event.target.value)}
      placeholder="new-agent" pattern="[a-z][a-z0-9-]{0,63}" /></label>
    <label className="field">Agent Markdown<textarea value={content} rows={12} disabled={saving.state.pending} onChange={event => setContent(event.target.value)} /></label>
    <div className="button-row"><button className="primary-button" type="button" disabled={!ready || !id || !content || recovery || saving.state.pending}
      onClick={() => void save()}>Save agent</button>
      <button className="secondary-button" type="button" disabled={!ready || !id || saving.state.pending} onClick={() => void recover()}>Check saved definition</button>
      <button className="secondary-button" type="button" disabled={!ready || saving.state.pending} onClick={() => void refresh()}>Refresh agents</button></div>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
