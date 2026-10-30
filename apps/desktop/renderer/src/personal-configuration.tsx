import { useEffect, useRef, useState } from 'react';
import { INVOICE_REVIEW_TOOL_NAMES, SKILL_RESOURCE_TOOL_NAMES, resourceRefKey, type ExtensionCatalog, type ModelProfile,
  type PersonalAgentConfiguration, type ResourceCatalog, type ResourceRef } from '@flowmate/contracts';

const tools: readonly string[] = [...INVOICE_REVIEW_TOOL_NAMES, ...SKILL_RESOURCE_TOOL_NAMES, 'Agent'];
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const label = (ref: ResourceRef) => `${ref.id} ${ref.version}`;
type Props = { ready: boolean; hostEpoch: number; disabled: boolean; models: readonly ModelProfile[];
  configuration: { revision: number; value: PersonalAgentConfiguration } | null;
  onChange(value: PersonalAgentConfiguration): void; onSave(): void; onReload(): void; onModels(): void };

export function PersonalConfiguration(props: Props) {
  const [expanded, setExpanded] = useState(false), [pending, setPending] = useState(false);
  const [resources, setResources] = useState<ResourceCatalog | null>(null), [extensions, setExtensions] = useState<ExtensionCatalog | null>(null);
  const [error, setError] = useState<string | null>(null), generation = useRef(0);
  async function refresh() {
    const token = ++generation.current; setPending(true); setError(null);
    try {
      const [resourceResult, extensionResult] = await Promise.all([window.flowmate.listResources(), window.flowmate.listExtensions()]);
      if (token !== generation.current) return;
      setResources(resourceResult.ok ? resourceResult.data : null); setExtensions(extensionResult.ok ? extensionResult.data : null);
      setError([resourceResult.ok ? null : resourceResult.error.message, extensionResult.ok ? null : extensionResult.error.message].filter(Boolean).join(' ') || null);
    } catch { if (token === generation.current) { setResources(null); setExtensions(null); setError('The local resource directory could not be read. Your configuration draft is retained.'); } }
    finally { if (token === generation.current) setPending(false); }
  }
  useEffect(() => { if (props.ready && expanded) void refresh(); return () => { generation.current++; }; }, [props.ready, props.hostEpoch, expanded]);
  const value = props.configuration?.value;
  const selected = (ref: ResourceRef) => value?.resources.enabledSkills.some(item => resourceRefKey(item) === resourceRefKey(ref)) === true;
  function resourceProblem(item: ResourceCatalog['items'][number], visiting: readonly string[] = []): string | null {
    const key = resourceRefKey(item.ref);
    if (visiting.includes(key)) return 'Selected Skill dependencies contain a cycle.';
    const diagnostic = item.diagnostics.find(diagnostic => diagnostic.code !== 'resource_dependency_missing');
    if (diagnostic) return diagnostic.message;
    for (const dependency of item.dependencies) {
      if (dependency.kind === 'extension') return `No Durable phase adapter for extension ${dependency.id} ${dependency.version}.`;
      if (dependency.kind === 'tool') {
        if (!tools.includes(dependency.name)) return `No Durable adapter for tool ${dependency.name}.`;
        if (!value?.tools.includes(dependency.name)) return `Enable tool ${dependency.name} first.`;
      } else {
        const ref: ResourceRef = { kind: 'skill', id: dependency.id, version: dependency.version };
        if (!selected(ref)) return `Enable Skill ${label(ref)} first.`;
        const required = resources?.items.find(candidate => resourceRefKey(candidate.ref) === resourceRefKey(ref));
        if (!required) return `Skill ${label(ref)} is unavailable.`;
        const problem = resourceProblem(required, [...visiting, key]); if (problem) return problem;
      }
    }
    return null;
  }
  const models = props.models.filter(model => model.kind !== 'legacy');
  return <details className="panel personal-configuration" onToggle={event => setExpanded(event.currentTarget.open)}><summary>Assistant configuration</summary>
    {value && props.configuration ? <form onSubmit={event => { event.preventDefault(); props.onSave(); }}>
      <p>Changes apply to new work. Accepted work keeps its original configuration and resource versions.</p>
      <label className="field"><span id="personal-agent-model-label">Personal Agent model</span><select aria-labelledby="personal-agent-model-label" value={value.modelId ?? ''} disabled={props.disabled}
        onChange={event => props.onChange({ ...value, modelId: event.target.value || null })}>
        <option value="">Choose a saved model</option>{value.modelId && !models.some(model => model.id === value.modelId) && <option value={value.modelId} disabled>Unavailable model {value.modelId}</option>}
        {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      <label className="field"><span id="personal-agent-thinking-label">Personal Agent thinking level</span><select aria-labelledby="personal-agent-thinking-label" value={value.thinkingLevel} disabled={props.disabled}
        onChange={event => { const thinkingLevel = thinkingLevels.find(level => level === event.target.value); if (thinkingLevel) props.onChange({ ...value, thinkingLevel }); }}>
        {thinkingLevels.map(level => <option key={level}>{level}</option>)}</select></label>
      <label className="field"><span id="personal-agent-preferences-label">Assistant preferences</span><textarea aria-labelledby="personal-agent-preferences-label" maxLength={22000} value={value.preferences} disabled={props.disabled}
        onChange={event => props.onChange({ ...value, preferences: event.target.value })} /></label>
      <label className="field"><span id="personal-agent-directory-label">Personal Agent working directory</span><input aria-labelledby="personal-agent-directory-label" maxLength={4096} value={value.workingDirectory ?? ''} disabled={props.disabled}
        placeholder="Automatic work directory" onChange={event => props.onChange({ ...value, workingDirectory: event.target.value || null })} /></label>
      <fieldset disabled={props.disabled}><legend>Personal Agent tools</legend>{[...new Set([...tools, ...value.tools])].map(name => <label className="personal-document-option" key={name}>
        <input type="checkbox" aria-label={`Enable Personal Agent tool ${name}`} checked={value.tools.includes(name)} onChange={event => props.onChange({ ...value,
          tools: event.target.checked ? [...value.tools, name] : value.tools.filter(tool => tool !== name) })} />{name}{!tools.includes(name) && <small>No Durable adapter; remove this selection.</small>}</label>)}</fieldset>
      <div className="button-row"><button type="button" disabled={!props.ready || pending || props.disabled} onClick={() => void refresh()}>Refresh assistant resources</button></div>
      {pending && <p role="status">Loading local resource versions…</p>}{error && <p role="alert">{error}</p>}
      <label className="field"><span id="personal-agent-prompt-label">Personal Agent Prompt</span><select aria-labelledby="personal-agent-prompt-label" value={value.resources.prompt ? resourceRefKey(value.resources.prompt) : ''} disabled={props.disabled || pending || !resources}
        onChange={event => { const prompt = resources?.items.find(item => resourceRefKey(item.ref) === event.target.value)?.ref ?? null;
          props.onChange({ ...value, resources: { ...value.resources, prompt } }); }}>
        <option value="">No business Prompt</option>
        {value.resources.prompt && !resources?.items.some(item => resourceRefKey(item.ref) === resourceRefKey(value.resources.prompt!))
          && <option value={resourceRefKey(value.resources.prompt)} disabled>Unavailable {label(value.resources.prompt)}</option>}
        {resources?.items.filter(item => item.ref.kind === 'prompt').map(item => { const problem = resourceProblem(item); return <option key={resourceRefKey(item.ref)} value={resourceRefKey(item.ref)} disabled={problem !== null}>
          {label(item.ref)}{problem ? ` · ${problem}` : ''}</option>; })}</select></label>
      {value.resources.prompt && <button type="button" disabled={props.disabled} onClick={() => props.onChange({ ...value, resources: { ...value.resources, prompt: null } })}>Use no Personal Agent Prompt</button>}
      <fieldset disabled={props.disabled}><legend>Personal Agent Skills</legend>{resources?.items.filter(item => item.ref.kind === 'skill').map(item => {
        const enabled = selected(item.ref), problem = resourceProblem(item);
        return <div key={resourceRefKey(item.ref)}><label className="personal-document-option"><input type="checkbox" aria-label={`Enable Skill ${label(item.ref)}`} checked={enabled}
          disabled={pending || !enabled && problem !== null} onChange={event => props.onChange({ ...value, resources: { ...value.resources,
            enabledSkills: event.target.checked ? [...value.resources.enabledSkills.filter(ref => ref.id !== item.ref.id), item.ref]
              : value.resources.enabledSkills.filter(ref => resourceRefKey(ref) !== resourceRefKey(item.ref)) } })} />{label(item.ref)}</label>
          {problem && <p>{problem}</p>}</div>;
      })}{resources && !resources.items.some(item => item.ref.kind === 'skill') && <p>No registered Skills.</p>}
        {value.resources.enabledSkills.filter(ref => !resources?.items.some(item => resourceRefKey(item.ref) === resourceRefKey(ref))).map(ref => <p key={resourceRefKey(ref)}>
          Unavailable selected Skill {label(ref)}. <button type="button" onClick={() => props.onChange({ ...value, resources: { ...value.resources,
            enabledSkills: value.resources.enabledSkills.filter(item => resourceRefKey(item) !== resourceRefKey(ref)) } })}>Remove Skill {label(ref)}</button></p>)}</fieldset>
      {resources?.diagnostics.map((item, index) => <p key={index}>Resource {item.resourceId ?? 'directory'} {item.version} · {item.message}</p>)}
      <fieldset disabled={props.disabled}><legend>Personal Agent extensions</legend><p>No Durable phase adapter is available for extensions.</p>
        {extensions?.items.map(item => <p key={`${item.ref.id}:${item.ref.version}`}>{item.ref.id} {item.ref.version} · unavailable in Personal Agent</p>)}
        {value.extensions.enabledExtensions.map(ref => <p key={`${ref.id}:${ref.version}`}>Unsupported selected extension {ref.id} {ref.version}.{' '}
          <button type="button" onClick={() => props.onChange({ ...value, extensions: { enabledExtensions: value.extensions.enabledExtensions.filter(item => item.id !== ref.id) } })}>Remove extension {ref.id} {ref.version}</button></p>)}</fieldset>
      <p>Saved configuration revision {props.configuration.revision}. Enabled tools: {value.tools.join(', ') || 'none'}.</p>
      <div className="button-row"><button type="submit" disabled={props.disabled}>Save assistant configuration</button><button type="button" onClick={props.onModels}>Manage saved models</button>
        <button type="button" disabled={!props.ready || props.disabled} onClick={props.onReload}>Reload saved configuration</button></div>
    </form> : <p>Assistant configuration is not available.</p>}
  </details>;
}
