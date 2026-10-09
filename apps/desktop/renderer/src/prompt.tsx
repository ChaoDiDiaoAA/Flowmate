import { useEffect, useRef, useState } from 'react';
import { skillIntroduction } from './skill-introductions.ts';
import type { ResourceCatalog, ResourceFilePage, ResourceRef, ResourceSelection, ResourceSelectionResult, RunResourceView } from '@flowmate/contracts';
import { EMPTY_RESOURCE_SELECTION, resourceRefKey } from '../../../../packages/contracts/src/resources.ts';
import { useRead, type ContextIdentity } from './context-state.ts';

type Item = ResourceCatalog['items'][number];
const label = (ref: ResourceRef) => `${ref.id} ${ref.version}`;
const introduction = (item: Item) => item.ref.kind === 'skill' ? skillIntroduction(item.description) : item.description;
export function ResourceFile({ identity, ref: resource, path, run, enabled = true }: {
  identity: ContextIdentity; ref: ResourceRef; path: string; run?: { sessionId: number; runId: number }; enabled?: boolean;
}) {
  const file = useRead<ResourceFilePage>(identity, `${resourceRefKey(resource)}:${path}`);
  async function load(offset = 0) {
    await file.read(`file:${offset}`, () => run
      ? window.flowmate.readRunResourceFile({ ...run, ref: resource, path, offset })
      : window.flowmate.readResourceFile({ ref: resource, path, offset }), value => resourceRefKey(value.ref) === resourceRefKey(resource)
        && value.path === path && value.offset === offset && (offset === 0 || value.sha256 === file.state.data?.sha256),
      offset === 0 ? undefined : (previous, next) => ({ ...next, text: (previous?.text ?? '') + next.text }));
  }
  useEffect(() => { if (enabled) void load(); }, [identity.hostEpoch, identity.selectionToken, resourceRefKey(resource), path, enabled]);
  return <section aria-label="Resource file"><h4>{path}</h4>
    {!enabled && <p>Enable this Skill to read its files.</p>}
    {file.state.error && <p role="alert">{file.state.error}</p>}
    {file.state.pending && <p>Loading resource…</p>}
    {enabled && file.state.data && <><p>{file.state.data.totalBytes} bytes · SHA-256 {file.state.data.sha256}</p>
      <pre data-testid="resource-file" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{file.state.data.text}</pre>
      {file.state.data.nextOffset !== null && <button className="secondary-button" disabled={file.state.pending}
        onClick={() => void load(file.state.data!.nextOffset!)}>Read more</button>}</>}
    {enabled && <button className="text-button" disabled={file.state.pending} onClick={() => void load()}>Reload file</button>}
  </section>;
}

export function ResourcePage({ kind, hostEpoch, ready, revision, onSaved, embedded = false }: {
  kind: 'prompt' | 'skill'; hostEpoch: number; ready: boolean; revision: number; onSaved(): Promise<void>; embedded?: boolean;
}) {
  const identity: ContextIdentity = { hostEpoch, sessionId: 0, runId: null, selectionToken: 0 };
  const catalog = useRead<ResourceCatalog>(identity), saving = useRead<ResourceSelectionResult>(identity);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<Item | null>(null), [path, setPath] = useState('');
  const [notice, setNotice] = useState(''), [refreshRequired, setRefreshRequired] = useState(false);
  async function refresh() {
    const value = await catalog.read('catalog', () => window.flowmate.listResources(), value => value.settingsRevision >= revision);
    if (value) { setRefreshRequired(false); setSelected(current => current && value.items.find(item => resourceRefKey(item.ref) === resourceRefKey(current.ref)) || null); }
  }
  useEffect(() => { setNotice(''); setRefreshRequired(false); setSelected(null); if (ready) void refresh(); }, [hostEpoch, ready]);
  useEffect(() => { if (ready && !saving.state.pending && !refreshRequired) void refresh(); }, [revision]);
  async function save(selection: ResourceSelection) {
    if (!ready || saving.state.pending || refreshRequired) return;
    const expectedRevision = catalog.state.data?.settingsRevision ?? revision;
    setNotice('');
    const result = await saving.read(`save:${expectedRevision}`, () => window.flowmate.updateResourceSelection({ expectedRevision, selection }),
      value => value.revision === expectedRevision + 1 && JSON.stringify(value.selection) === JSON.stringify(selection));
    if (!alive.current) return;
    if (!result) { setRefreshRequired(true); return; }
    setNotice('Saved. Changes apply to later Runs.'); await onSaved(); if (alive.current) await refresh();
  }
  const data = catalog.state.data;
  const blocked = !ready || !data || data.settingsRevision < revision || catalog.state.pending || saving.state.pending || refreshRequired;
  const visible = data?.items.filter(item => item.ref.kind === kind && (filter === 'all' || filter === 'ready' && item.enabled && item.available || filter === 'disabled' && !item.enabled
    || filter === 'partial' && item.enabled && !item.available)
    && `${item.name} ${item.ref.id} ${item.ref.version} ${item.description} ${introduction(item)} ${item.keywords.join(' ')}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const title = kind === 'prompt' ? 'Business instructions' : 'Skills';
  return <section className={embedded ? 'embedded-resources' : 'page-content'}>{kind === 'prompt' ? <div className="page-heading"><div>{embedded ? <h2>{title}</h2> : <h1>{title}</h1>}
    <p>Choose the business instructions for future conversations.</p></div>
    <button className="secondary-button" disabled={!ready || catalog.state.pending || saving.state.pending} onClick={() => void refresh()}>Refresh resources</button></div>
    : embedded ? <h2 className="sr-only">Skills</h2> : <h1 className="sr-only">Skills</h1>}
    {notice && <p role="status">{notice}</p>}{!ready && <p role="alert">The Host is unavailable.</p>}
    {catalog.state.error && <p role="alert">{catalog.state.error}</p>}{saving.state.error && <p role="alert">{saving.state.error}</p>}
    {refreshRequired && <p role="alert">Refresh resources to confirm the saved selection before trying again.</p>}
    {kind === 'skill' && <div className="skill-controls"><div className="skill-search"><label className="field"><span className="sr-only">Search skills</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg>
      <input aria-label="Search skills" placeholder="Search skills…" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <button className="skill-refresh text-button" aria-label="Refresh resources" title="Refresh resources" disabled={!ready || catalog.state.pending || saving.state.pending} onClick={() => void refresh()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-2l2 2M18 17a7 7 0 0 1-12 2l-2-2" /></svg></button></div>
      <div className="skill-filters" aria-label="Skill status">{['all', 'ready', 'partial', 'disabled'].map(status =>
        <button key={status} className="secondary-button" aria-pressed={filter === status} onClick={() => setFilter(status)}>{status[0]!.toUpperCase() + status.slice(1)}</button>)}</div></div>}
    {kind === 'prompt' && <button className="text-button" disabled={!ready || catalog.state.pending || saving.state.pending || refreshRequired}
      onClick={() => void save(EMPTY_RESOURCE_SELECTION)}>Clear all resource selections</button>}
    {kind === 'prompt' && <p>Selected: {data?.selection.prompt ? label(data.selection.prompt) : 'None'} <button className="text-button" disabled={blocked || !data?.selection.prompt}
      onClick={() => data && void save({ ...data.selection, prompt: null })}>Use no business Prompt</button></p>}
    {data?.diagnostics.map((item, index) => <p key={index} role="alert">{item.resourceId ?? 'Resource'} {item.version} · {item.code} · {item.message}</p>)}
    {data?.selection.enabledSkills.filter(ref => !data.items.some(item => resourceRefKey(item.ref) === resourceRefKey(ref))).map(ref => <p key={resourceRefKey(ref)}>
      Missing enabled version: {label(ref)} <button disabled={blocked} onClick={() => void save({ ...data.selection,
        enabledSkills: data.selection.enabledSkills.filter(item => resourceRefKey(item) !== resourceRefKey(ref)) })}>Disable missing {label(ref)}</button></p>)}
    <div className={kind === 'skill' ? 'skill-list' : 'model-list'}>{visible.map(item => {
      const matched = item.dependencyChecks.filter(check => check.available).length, total = item.dependencyChecks.length;
      return <article className={kind === 'skill' ? 'skill-row' : 'panel'} key={resourceRefKey(item.ref)}>
      {kind === 'skill' ? <><div className="skill-row-main"><div className="skill-row-copy"><h3>
        <button className="skill-name" aria-label={`View ${item.name === item.ref.id ? label(item.ref) : `${item.name} (${label(item.ref)})`}`} title={item.name} onClick={() => { setSelected(item); setPath(item.bodyFile); }}>{item.name}</button></h3>
        <p title={introduction(item)}>{introduction(item)}</p></div>
        <div className="skill-readiness"><span className={`skill-capability-mark ${total && matched === 0 ? 'empty' : matched < total ? 'partial' : item.available ? 'ready' : 'unavailable'}`} aria-hidden="true" />
          <span className="skill-capability-count">{total ? `${matched}/${total} capabilities` : 'No requirements'}</span>
          <span className="sr-only">{!item.enabled ? 'Disabled' : item.available ? 'Ready' : 'Partial'}</span>
          {item.dependencyChecks.some(check => !check.available) && <div className="skill-missing">{item.dependencyChecks.filter(check => !check.available).map((check, index) =>
            <button key={index} title={check.reason ?? undefined} onClick={() => { setSelected(item); setPath(item.bodyFile); }}>{check.dependency.kind === 'tool' ? check.dependency.name : check.dependency.id}</button>)}</div>}
          {!item.available && matched === total && <span className="skill-unavailable" role="alert">Unavailable</span>}</div>
        <button type="button" role="switch" aria-checked={item.enabled} aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${label(item.ref)}`}
          className="resource-switch" disabled={blocked || !item.enabled && !item.available} onClick={() => data && void save({ ...data.selection,
            enabledSkills: item.enabled ? data.selection.enabledSkills.filter(ref => resourceRefKey(ref) !== resourceRefKey(item.ref))
              : [...data.selection.enabledSkills.filter(ref => ref.id !== item.ref.id), item.ref] })}><span /></button></div>
      </> : <><h3>{label(item.ref)}</h3><p>{item.description}</p>
      <p>{item.enabled ? 'Selected / enabled' : 'Disabled'} · {item.available ? 'Verified discovery' : 'Unavailable'}{item.disableModelInvocation && ' · Explicit invocation only'}</p>
      <button className="text-button" onClick={() => { setSelected(item); setPath(item.bodyFile); }}>View {label(item.ref)}</button>{' '}
      <button className="secondary-button" disabled={blocked || !item.enabled && !item.available} onClick={() => data && void save(kind === 'prompt'
        ? { ...data.selection, prompt: item.ref } : { ...data.selection, enabledSkills: item.enabled
          ? data.selection.enabledSkills.filter(ref => resourceRefKey(ref) !== resourceRefKey(item.ref))
          : [...data.selection.enabledSkills.filter(ref => ref.id !== item.ref.id), item.ref] })}>{kind === 'prompt' ? 'Use' : item.enabled ? 'Disable' : 'Enable'} {label(item.ref)}</button>
      {item.diagnostics.map((diagnostic, index) => <p key={index} role="alert">{diagnostic.code} · {diagnostic.message}</p>)}</>}</article>;
    })}</div>
    {data && visible.length === 0 && <p>No matching resources.</p>}
    {kind === 'skill' && <details className="skill-recovery"><summary>Resource recovery</summary>
      <button className="text-button" disabled={!ready || catalog.state.pending || saving.state.pending || refreshRequired}
        onClick={() => void save(EMPTY_RESOURCE_SELECTION)}>Clear all resource selections</button></details>}
    {selected && <section className="panel" aria-label="Resource details"><h3>{label(selected.ref)}</h3><p>Content SHA-256 {selected.ref.contentHash}</p>
      {kind === 'skill' && <><p>{selected.name} · {introduction(selected)}</p>{selected.diagnostics.map((diagnostic, index) => <p key={index} role="alert">{diagnostic.code} · {diagnostic.message}</p>)}</>}
      <p>Keywords: {selected.keywords.join(', ') || 'None'}</p><h4>Dependencies</h4>
      {selected.dependencyChecks.length ? <ul>{selected.dependencyChecks.map((check, index) => <li key={index}>{check.dependency.kind} · {'name' in check.dependency ? check.dependency.name : check.dependency.id}
        {'version' in check.dependency ? ` ${check.dependency.version}` : ''} · {check.available ? 'Ready' : check.reason}</li>)}</ul> : <p>No requirements</p>}
      {kind === 'skill' && <p>{selected.disableModelInvocation ? 'Explicit invocation only.' : 'Available for automatic discovery when enabled and ready.'}</p>}
      <label>Resource file<select aria-label="Resource file" value={path} onChange={event => setPath(event.target.value)}>{selected.files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>
      <ResourceFile key={`${resourceRefKey(selected.ref)}:${path}`} identity={identity} ref={selected.ref} path={path} enabled={ready && (kind === 'prompt' || selected.enabled)} />
      <p>Reading references, assets or scripts does not execute scripts or install dependencies.</p></section>}
  </section>;
}

export function RunResources({ identity, ready, refreshToken }: { identity: ContextIdentity; ready: boolean; refreshToken: number }) {
  const facts = useRead<RunResourceView>(identity), [selected, setSelected] = useState<{ ref: ResourceRef; path: string } | null>(null);
  async function refresh() { if (identity.runId !== null) await facts.read('run-resources', () => window.flowmate.queryRunResources({ sessionId: identity.sessionId, runId: identity.runId! }),
    value => value.sessionId === identity.sessionId && value.runId === identity.runId); }
  useEffect(() => { setSelected(null); if (ready) void refresh(); }, [identity.hostEpoch, identity.sessionId, identity.runId, identity.selectionToken, ready]);
  useEffect(() => { if (ready) void refresh(); }, [refreshToken]);
  const data = facts.state.data;
  return <section aria-label="Run resources"><h3>Run resources</h3><button className="text-button" disabled={!ready || identity.runId === null || facts.state.pending} onClick={() => void refresh()}>Refresh Run resources</button>
    {facts.state.error && <p role="alert">{facts.state.error}</p>}{facts.state.pending && <p>Loading resources…</p>}
    {data && <>{data.gap && <p>Evidence unavailable · {data.gap}</p>}
      <p>Prompt: {data.frozen?.prompt ? label(data.frozen.prompt) : 'None recorded'} · Bundle: {data.frozen?.bundleHash ?? 'None recorded'}</p>
      <p>Selected Skills: {data.frozen?.selectedSkills.map(label).join(', ') || 'None recorded'}</p>
      <p>Discovered Skills: {data.frozen?.discoveredSkills.map(label).join(', ') || 'None recorded'}</p>
      {data.frozen?.excludedSkills.map(item => <p key={resourceRefKey(item.ref)}>Excluded {label(item.ref)} · {item.code}</p>)}
      {data.evidence?.expansions.map(item => <p key={item.inputId}>Expanded {label(item.skill)} · Input {item.inputId} · Native entry {item.nativeEntryId}</p>)}
      {data.evidence?.reads.map(item => <p key={`${item.toolCallId}:${item.operation}:${item.path}`}>Read {label(item.ref)} / {item.path} · {item.operation} · Tool {item.toolCallId} · {item.operation === 'list_skill_resources' ? 'Listed'
        : item.fullBody === true ? item.path === data.frozen?.manifests.find(pack => resourceRefKey(pack.ref) === resourceRefKey(item.ref))?.manifest.bodyFile ? 'Skill body · Full file' : 'Full file' : 'Partial file or search result'}</p>)}
      {data.evidence?.requests.map(item => <article key={`${item.purpose}:${item.callSequence}:${item.compactionOperationId}`}><h4>{item.purpose} request {item.callSequence}</h4>
        {item.contentChecks.map((check, index) => <p key={index}>{label(check.ref)} · {check.scope} · SDK {check.sdkInclusion} · HTTP {check.wireInclusion}{check.reason && ` · ${check.reason}`}</p>)}</article>)}
      <p>Discovery, reading and request inclusion do not prove that the model followed the resource.</p>
      {[...(data.frozen?.prompt ? [data.frozen.prompt] : []), ...(data.frozen?.discoveredSkills ?? [])].map(ref => <button className="text-button" key={resourceRefKey(ref)} disabled={!ready || data.gap !== null}
        onClick={() => setSelected({ ref, path: ref.kind === 'prompt' ? 'prompt.md' : 'SKILL.md' })}>View fixed {label(ref)}</button>)}
      {selected && <><label>Fixed file path<input aria-label="Fixed file path" value={selected.path} onChange={event => setSelected({ ...selected, path: event.target.value })} /></label>
        <ResourceFile key={`${identity.runId}:${resourceRefKey(selected.ref)}:${selected.path}`} identity={identity} ref={selected.ref} path={selected.path}
          run={{ sessionId: identity.sessionId, runId: identity.runId! }} enabled={ready} /></>}
    </>}
  </section>;
}
