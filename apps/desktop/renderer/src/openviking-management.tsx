import { useState } from 'react';
import { openVikingManagement, type OpenVikingManagementMethod, type OpenVikingManagementReceipt, type OpenVikingManagementView } from '../../../../packages/contracts/src/openviking-management.ts';

export function OpenVikingManagementPanel() {
  const [connection, setConnection] = useState<OpenVikingManagementView | null>(null);
  const [method, setMethod] = useState<OpenVikingManagementMethod | ''>('');
  const [parameters, setParameters] = useState('{}');
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<OpenVikingManagementReceipt | null>(null);
  const unresolved = !!receipt && ['unknown', 'accepted', 'running'].includes(receipt.state);
  const available = (Object.keys(openVikingManagement) as OpenVikingManagementMethod[])
    .filter(key => connection && openVikingManagement[key].roles.includes(connection.role));
  const api = window.flowmate.openVikingManagement;
  async function refreshReceipt(id: string) {
    const found = await api.receipt(id);
    if (!found.ok) throw Error(found.error.message);
    setReceipt(found.data);
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'OpenViking management is unavailable.'); }
    finally { setBusy(false); }
  }
  return <details>
    <summary>OpenViking management</summary>
    <p>Select a local OpenViking identity file or a dedicated Cloud Authority SSH identity file. P manages user data, A manages one account, and S manages the system.</p>
    <p>For cloud management, use a file with kind cloud, workspaceId, role and target. The Authority verifies the role and holds the OpenViking key.</p>
    <button type="button" disabled={busy} onClick={() => void run(async () => {
      const connected = await api.connect();
      if (!connected.ok) throw Error(connected.error.message);
      if (!connected.data) return;
      setConnection(connected.data);
      setReceipt(null);
      setMethod('');
      setParameters('{}');
      await refreshReceipt(connected.data.connectionId);
    })}>Select management identity</button>
    {connection && <>
      <p>{connection.role} · {connection.endpoint}{connection.accountId ? ` · ${connection.accountId}` : ''}</p>
      <button type="button" disabled={busy} onClick={() => void run(async () => {
        const disconnected = await api.disconnect(connection.connectionId);
        if (!disconnected.ok) throw Error(disconnected.error.message);
        setConnection(null);
        setReceipt(null);
      })}>Disconnect management identity</button>
      {receipt && <p>Operation {receipt.method} · {receipt.operationId} · {receipt.state}{receipt.taskId ? ` · task ${receipt.taskId}` : ''}</p>}
      {receipt && unresolved && <div>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const checked = await api.resolveReceipt({ connectionId: connection.connectionId, operationId: receipt.operationId, action: 'check' });
          if (!checked.ok) throw Error(checked.error.message);
          setReceipt(checked.data);
        })}>Check original target or resume file</button>
        <button type="button" disabled={busy} onClick={() => void run(async () => {
          const checked = await api.resolveReceipt({ connectionId: connection.connectionId, operationId: receipt.operationId, action: 'abandon' });
          if (!checked.ok) throw Error(checked.error.message);
          setReceipt(checked.data);
        })}>Abandon reconciliation</button>
      </div>}
      <label>Operation <select disabled={busy} value={method} onChange={event => {
        setMethod(event.target.value as OpenVikingManagementMethod | '');
        setParameters('{}');
        setResult(undefined);
        setError(undefined);
      }}><option value="">Choose an operation</option>{available.map(key => <option key={key}>{key}</option>)}</select></label>
      {method && <>
        <p>Fields {Object.keys(openVikingManagement[method].input.shape).join(', ') || 'none'}</p>
        {method === 'CreateSession' && <p>Leave sessionId blank to generate one. Management-created session IDs start with flowmate-management-.</p>}
        <label>Parameters and options (JSON) <textarea disabled={busy} maxLength={24000} value={parameters}
          onChange={event => setParameters(event.target.value)} /></label>
        <button type="button" disabled={busy || unresolved && openVikingManagement[method].mutates} onClick={() => void run(async () => {
          const parsed = openVikingManagement[method].input.safeParse(JSON.parse(parameters));
          if (!parsed.success) throw Error(parsed.error.issues.map(issue => `${issue.path.join('.') || 'parameters'} ${issue.message}`).join('. '));
          const response = await api.execute({ connectionId: connection.connectionId, method, input: parsed.data });
          await refreshReceipt(connection.connectionId);
          if (!response.ok) throw Error(response.error.message);
          setResult(JSON.stringify(response.data, null, 2));
        })}>{openVikingManagement[method].mutates ? 'Review change' : 'Run query'}</button>
      </>}
    </>}
    {error && <p role="alert">{error}</p>}
    {result && <pre role="status">{result}</pre>}
  </details>;
}
