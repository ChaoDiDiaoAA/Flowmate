import { CaseEvaluationFaultProfileSchema, ExtensionEvaluationProfileSchema, type DesktopState } from '@flowmate/contracts';
import { createWriteStream } from 'node:fs';
import { EvaluationAgentOverridesSchema, type EvaluationAgentOverrides } from '../../packages/contracts/src/runtime-evaluation.ts';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createProductCommandDispatcher } from './dispatch.ts';
import { parseHostCommand, type HostOutput } from './protocol.ts';

for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  console[method] = (...values: unknown[]) => process.stderr.write(`${values.map((value) => String(value)).join(' ')}\n`);
}

// Bun's native stdout can block inside write on Windows and reports no queue length.
// This fd=1 stream tracks real bytes waiting for pipe drain for every protocol line.
const stdout = createWriteStream('', { fd: 1, autoClose: false });
stdout.on('error', () => { /* parent may already have exited; runHost also releases observers */ });
function send(value: HostOutput): Promise<void> {
  if (value.type === 'event' && value.event.type === 'runtime_events_available' && stdout.writableLength >= 262144) return Promise.resolve();
  return new Promise(resolveWritten => {
    try { stdout.write(`${JSON.stringify(value)}\n`, () => resolveWritten()); }
    catch { resolveWritten(); }
  });
}

function startupRoot(): string | null {
  const index = process.argv.indexOf('--user-data-root');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && isAbsolute(value) ? value : null;
}

function startupInvoiceSourceRoot(): string | null {
  const index = process.argv.indexOf('--invoice-source-root');
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && isAbsolute(value) ? value : null;
}

function startupRuntimeRoot(): string | undefined | null {
  const occurrences = process.argv.filter(value => value === '--runtime-root').length;
  if (!occurrences) return undefined;
  const value = process.argv[process.argv.indexOf('--runtime-root') + 1];
  return occurrences === 1 && value && isAbsolute(value) ? value : null;
}

function startupExtensionEvaluationProfile() {
  const flag = '--eval-extension-profile', occurrences = process.argv.filter(value => value === flag).length;
  if (occurrences === 0) return undefined;
  if (occurrences !== 1) return null;
  try { return ExtensionEvaluationProfileSchema.parse(JSON.parse(process.argv[process.argv.indexOf(flag) + 1] ?? '')); }
  catch { return null; }
}
const root = startupRoot();
const invoiceSourceRoot = startupInvoiceSourceRoot() ?? join(process.cwd(), 'data', 'invoices', 'agent-input');
const extensionEvaluationProfile = startupExtensionEvaluationProfile();
const runtimeRoot = startupRuntimeRoot();
const evaluationWorkspaceRoot = (() => { const flag = '--evaluation-workspace-root', count = process.argv.filter(value => value === flag).length;
  if (!count) return undefined;
  const value = process.argv[process.argv.indexOf(flag) + 1];
  return count === 1 && value && isAbsolute(value) ? resolve(value) : null;
})();
const evaluationTrialRoot = (() => { const flag = '--evaluation-trial-root', count = process.argv.filter(value => value === flag).length;
  if (!count) return undefined;
  const value = process.argv[process.argv.indexOf(flag) + 1];
  return count === 1 && value && isAbsolute(value) ? resolve(value) : null;
})();
const evaluationOverrides = (() => { const flag = '--eval-agent-overrides', count = process.argv.filter(value => value === flag).length;
  if (!count) return undefined; if (count !== 1) return null;
  try { return EvaluationAgentOverridesSchema.parse(JSON.parse(process.argv[process.argv.indexOf(flag) + 1] ?? '')); } catch { return null; }
})();
const caseEvaluationFaultProfile=(()=>{const flag='--eval-case-fault-profile',count=process.argv.filter(v=>v===flag).length;
  if(!count)return undefined;if(count!==1)return null;
  try{return CaseEvaluationFaultProfileSchema.parse(JSON.parse(process.argv[process.argv.indexOf(flag)+1]??''));}catch{return null;}})();
if (!root || runtimeRoot === null || evaluationWorkspaceRoot === null || evaluationTrialRoot === null || evaluationWorkspaceRoot && evaluationTrialRoot || evaluationOverrides === null || process.argv.some(arg=>['--eval-runtime-fault-profile','--eval-runtime-policy'].includes(arg)) || extensionEvaluationProfile === null || caseEvaluationFaultProfile===null || [extensionEvaluationProfile,caseEvaluationFaultProfile].filter(Boolean).length>1) {
  send({ version: 1, type: 'ready', state: { version: 1, ready: false, host: 'error', appVersion: '0.0.0', userDataPath: '' } as Omit<DesktopState, 'modelCredentials'> });
  process.exitCode = 2;
} else {
  await runHost(root, invoiceSourceRoot, extensionEvaluationProfile,caseEvaluationFaultProfile,runtimeRoot,evaluationOverrides,evaluationWorkspaceRoot,evaluationTrialRoot);
}

async function runHost(userDataRoot: string, invoiceSourceRoot: string, extensionEvaluationProfile?: import('@flowmate/contracts').ExtensionEvaluationProfile,
  caseEvaluationFaultProfile?: import('@flowmate/contracts').CaseEvaluationFaultProfile, runtimeRoot?: string,
  evaluationOverrides?: EvaluationAgentOverrides, evaluationWorkspaceRoot?: string, evaluationTrialRoot?: string): Promise<void> {
  const created = await createProductCommandDispatcher({ userDataRoot, invoiceSourceRoot, extensionEvaluationProfile,
    caseEvaluationFaultProfile, runtimeRoot, evaluationOverrides, evaluationWorkspaceRoot, evaluationTrialRoot, send: async output => {
      await send(output);
      if (output.type === 'event' && output.event.type === 'host_state' && output.event.state.host === 'closing')
        setTimeout(() => process.exit(0), 30);
    } });
  if (!created.ok) { process.exitCode = 2; return; }
  const owner = created.data;
  stdout.once('error', () => owner.releaseRuntimeObservations());
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    if (Buffer.byteLength(line, 'utf8') > 1_100_000) return;
    let raw: unknown;
    try { raw = JSON.parse(line) as unknown; } catch { return; }
    const command = parseHostCommand(raw);
    if (command) void owner.dispatch(command);
  });
  // Recovery can request a key only after the credential-response reader is listening.
  void owner.startRecovery();
  input.on('close', () => {
    owner.releaseRuntimeObservations();
    let retry: ReturnType<typeof setInterval> | undefined;
    const closeEventually = async () => {
      const report = await owner.close();
      if (report.ok && report.data.closed) {
        if (retry) clearInterval(retry);
        process.exit(0);
      }
    };
    void closeEventually();
    retry = setInterval(() => { void closeEventually(); }, 500);
    retry.unref();
  });
}
