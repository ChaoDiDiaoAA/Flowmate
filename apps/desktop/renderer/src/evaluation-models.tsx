import { useEffect, useRef, useState } from 'react';
import { EvaluationApiSchema, EvaluationHttpJudgeConnectionSchema, SaveEvaluationSettingsSchema,
  type EvaluationConfigurationSnapshot, type EvaluationSettings } from '../../../../packages/contracts/src/evaluation.ts';

type Props = { revision: number; settings: EvaluationSettings | undefined;
  credentials: EvaluationConfigurationSnapshot['credentials'] | undefined; ready: boolean; onSaved(): Promise<void> };
const defaultJudgeTimeout = EvaluationHttpJudgeConnectionSchema.shape.timeoutMs.parse(undefined);
const apiLabels = { 'openai-completions': 'OpenAI Chat', 'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic', 'google-generative-ai': 'Google Gemini' };

function EvaluationModelForm({ role, revision, settings, credentials, ready, onSaved }: Props & { role: 'agent' | 'judge' }) {
  const profile = settings?.[role] ?? null, label = role === 'agent' ? 'Agent' : 'Judge';
  const savedNative = profile && 'provider' in profile ? profile : null;
  const savedHttp = profile && 'api' in profile ? profile : null;
  const currentTimeout = profile && 'timeoutMs' in profile ? profile.timeoutMs : defaultJudgeTimeout;
  const [api, setApi] = useState<string>(savedNative ? 'codex-cli' : savedHttp?.api ?? EvaluationApiSchema.options[0]);
  const [baseUrl, setBaseUrl] = useState(savedHttp?.baseUrl ?? ''), [model, setModel] = useState(profile?.model ?? '');
  const [executable, setExecutable] = useState(savedNative?.executable ?? 'codex'), [effort, setEffort] = useState(savedNative?.reasoningEffort ?? 'medium');
  const native = role === 'judge' && api === 'codex-cli';
  const [timeout, setTimeout] = useState(String(currentTimeout)), [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false), savingRef = useRef(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  useEffect(() => {
    setApi(savedNative ? 'codex-cli' : savedHttp?.api ?? EvaluationApiSchema.options[0]); setBaseUrl(savedHttp?.baseUrl ?? ''); setModel(profile?.model ?? '');
    setExecutable(savedNative?.executable ?? 'codex'); setEffort(savedNative?.reasoningEffort ?? 'medium');
    setTimeout(String(currentTimeout)); setApiKey('');
  }, [profile, currentTimeout]);
  async function save(clear: boolean) {
    if (savingRef.current || !ready) return;
    const parsed = SaveEvaluationSettingsSchema.safeParse({ expectedRevision: revision, role,
      connection: clear ? null : native ? { provider: 'codex-cli', executable: executable.trim(), model: model.trim(), reasoningEffort: effort, timeoutMs: Number(timeout) }
        : { api, baseUrl: baseUrl.trim(), model: model.trim(), ...(role === 'judge' ? { timeoutMs: Number(timeout) } : {}) },
      ...(!clear && !native && apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
    if (!parsed.success) { setMessage({ error: true, text: 'Check the API, credential-free Base URL, Model ID and timeout.' }); return; }
    savingRef.current = true; setSaving(true); setMessage(null); let acknowledged = false;
    try {
      const result = await window.flowmate.saveEvaluationSettings(parsed.data);
      acknowledged = result.ok;
      if (result.ok) { setApiKey(''); setMessage({ error: false, text: `${label} configuration ${clear ? 'cleared' : 'saved'}.` }); }
      else setMessage({ error: true, text: result.error.message });
      await onSaved();
    } catch {
      setMessage({ error: true, text: acknowledged ? 'Configuration saved; the saved settings could not be refreshed.'
        : 'Save response unavailable. Refresh the saved settings before trying again.' });
    } finally { savingRef.current = false; setSaving(false); }
  }
  const credential = credentials?.[role] ?? 'missing';
  return <form className="evaluation-model-card" aria-label={`Evaluation ${label} settings`} onSubmit={event => { event.preventDefault(); void save(false); }}>
    <div className="evaluation-model-heading"><h3>Evaluation {label}</h3>
      <span className={`credential-pill ${credential === 'configured' ? 'ready' : credential}`}>{native ? 'Native login' : credential === 'configured' ? 'Key saved' : credential === 'unavailable' ? 'Unavailable' : 'Not configured'}</span></div>
    <p className="evaluation-model-description">{role === 'agent' ? 'Runs the selected evaluation tasks.'
      : 'Scores applicable semantic requirements. Deterministic-only selections do not need a Judge.'}</p>
    <div className="form-grid">
      <label className="field"><span>API</span><select value={api} onChange={event => setApi(event.target.value)} disabled={saving}>
        {EvaluationApiSchema.options.map(value => <option key={value} value={value}>{apiLabels[value]}</option>)}
        {role === 'judge' && <option value="codex-cli">Codex CLI</option>}
      </select></label>
      <label className="field"><span>Model ID</span><input value={model} maxLength={128} spellCheck={false} required disabled={saving}
        onChange={event => setModel(event.target.value)} /></label>
      {native ? <><label className="field full"><span>Executable</span><input value={executable} maxLength={2048} required disabled={saving}
        onChange={event => setExecutable(event.target.value)} /></label>
        <label className="field full"><span>Reasoning effort</span><select value={effort} disabled={saving}
          onChange={event => setEffort(event.target.value as typeof effort)}>
          {['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => <option key={value} value={value}>{value}</option>)}
        </select></label></> : <><label className="field full"><span>Base URL</span><input type="url" value={baseUrl} maxLength={2048} spellCheck={false} required disabled={saving}
        placeholder="https://provider.example/v1" onChange={event => setBaseUrl(event.target.value)} /></label>
        <label className="field full"><span>API key</span><input type="password" value={apiKey} maxLength={4096} autoComplete="new-password" disabled={saving}
        placeholder={credential === 'configured' ? 'Leave blank to retain the saved key' : 'Enter a key for this role'} onChange={event => setApiKey(event.target.value)} /></label></>}
      {role === 'judge' && <label className="field full"><span>Timeout (ms)</span><input type="number" min={1} max={300_000} step={1}
        value={timeout} required disabled={saving} onChange={event => setTimeout(event.target.value)} /></label>}
    </div>
    <p className="evaluation-model-credential" role="status">{native ? 'Uses the existing native Codex login. Login is checked when a generation starts.' : !profile ? 'No connection saved.' : credential === 'configured'
      ? 'API key saved in secure storage.' : credential === 'unavailable' ? 'Secure credential storage is unavailable.' : 'API key required for this role.'}</p>
    {!native && <p className="evaluation-model-description">Changing the API or Base URL requires a new key. Keys are never displayed again.</p>}
    {message && <div className={`notice ${message.error ? 'bad' : 'good'}`} role={message.error ? 'alert' : 'status'}>{message.text}</div>}
    <div className="evaluation-model-actions">
      <button className="text-button danger-text" type="button" disabled={saving || !ready || !profile} onClick={() => void save(true)}>Clear {label}</button>
      <button className="text-button" type="button" disabled={saving} onClick={() => { void onSaved()
        .then(() => setMessage({ error: false, text: 'Saved settings refreshed.' }))
        .catch(() => setMessage({ error: true, text: 'Saved settings could not be refreshed.' })); }}>Refresh saved {label}</button>
      <button className="secondary-button" type="submit" disabled={saving || !ready}>{saving ? 'Saving…' : `Save evaluation ${label}`}</button>
    </div>
  </form>;
}
export function EvaluationModels(props: Props) {
  return <section className="panel evaluation-models" aria-labelledby="evaluation-models-heading">
    <div className="panel-head"><div><h2 id="evaluation-models-heading">Evaluation models</h2>
      <p>Separate connections for evaluation. Saving does not contact a model or change Assistant defaults.</p></div></div>
    <div className="evaluation-model-grid">{(['agent', 'judge'] as const).map(role => <EvaluationModelForm key={role} role={role} {...props} />)}</div>
  </section>;
}
