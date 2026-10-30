import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { buildRuntime } from '../../scripts/package.ts';
import { prepareServiceInstallation, type ServiceInstallation } from '../../packages/shared/src/service-layout.ts';
import { servicePipeName } from '../../apps/service/pipe.ts';
import type { HostOutput } from '../../apps/host/protocol.ts';
import type { CloseReport, Result } from '@flowmate/contracts';

export function removeOwnerFixture(root: string) {
  const inside = relative(resolve(tmpdir()), resolve(root));
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw Error('fixture_root_invalid');
  rmSync(root, { recursive: true, force: true });
}

export async function packageOwnerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'flowmate-service-owner-'));
  const runtimeRoot = join(root, 'resources/flowmate-runtime');
  try { await buildRuntime(resolve(import.meta.dir, '../..'), runtimeRoot); return { root, runtimeRoot }; }
  catch (error) { removeOwnerFixture(root); throw error; }
}

export async function installOwnerFixture(runtimeRoot: string, enabled = true) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'flowmate-service-data-'));
  const saved = await prepareServiceInstallation({ runtimeRoot, dataRoot });
  if (!saved.ok) { removeOwnerFixture(dataRoot); throw Error(saved.error.code); }
  if (!enabled) return saved.data;
  const prepared = await spawnOwnerFixture(saved.data);
  const initialized = await prepared.close();
  if (!initialized.ok || !initialized.data.stopped || !initialized.data.closed || await prepared.child.exited !== 0)
    throw Error('owner_fixture_preparation_unconfirmed');
  const published = { ...saved.data, enabled: true, activationOperationId: randomUUID() };
  writeFileSync(join(dataRoot, 'service-installation.json'), JSON.stringify(published));
  return published;
}

export async function spawnOwnerFixture(installation: ServiceInstallation, mode = '') {
  const child = Bun.spawn([process.execPath, '--no-env-file', import.meta.filename, '--run',
    join(installation.dataRoot, 'service-installation.json'), installation.runtimeRoot, mode],
  { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, OPENAI_API_KEY: 'must-not-be-used' } });
  let buffer = '', stderr = '';
  const messages: unknown[] = [];
  let completed: Result<CloseReport> | undefined;
  void (async () => { for await (const chunk of child.stdout) {
    buffer += Buffer.from(chunk).toString('utf8'); let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) { messages.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); }
  } })();
  void (async () => { for await (const chunk of child.stderr) stderr += Buffer.from(chunk).toString('utf8'); })();
  await waitOwner(() => messages.some(value => (value as { type: string }).type === 'fixture_ready'), () => stderr);
  return { child, messages, stderr: () => stderr, async close() {
    if (completed) return completed;
    const before = messages.length;
    child.stdin.write('close\n'); await child.stdin.flush();
    await waitOwner(() => messages.slice(before).some(value => (value as { type: string }).type === 'fixture_close'), () => stderr);
    const report = [...messages].reverse().find(value => (value as { type: string }).type === 'fixture_close') as { report: Result<CloseReport> };
    if (report.report.ok && report.report.data.closed) completed = report.report;
    return report.report;
  } };
}

export async function waitOwner(check: () => boolean, detail: () => string = () => '', timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await Bun.sleep(20); }
  throw Error('owner_fixture_timeout:' + detail());
}

export async function ownerClient(installation: ServiceInstallation, change: Record<string, unknown> = {}) {
  const socket = createConnection(servicePipeName(installation.installationId));
  const frames: Array<HostOutput | Record<string, unknown>> = [];
  let text = '';
  socket.on('data', data => {
    text += data.toString('utf8'); let end: number;
    while ((end = text.indexOf('\n')) >= 0) { frames.push(JSON.parse(text.slice(0, end))); text = text.slice(end + 1); }
  });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(JSON.stringify({ version: 1, type: 'service_connect', installationId: installation.installationId,
    releaseId: installation.releaseId, protocolVersion: 1, dataVersion: 21, ...change }) + '\n');
  await waitOwner(() => frames.length > 0 || socket.destroyed, () => 'hello:' + JSON.stringify(change));
  return { socket, frames, hello: frames[0]!, async call<T = unknown>(command: Record<string, unknown>): Promise<Result<T>> {
    const requestId = typeof command.requestId === 'string' ? command.requestId : randomUUID();
    const before = frames.length;
    socket.write(JSON.stringify({ version: 1, ...command, requestId }) + '\n');
    await waitOwner(() => frames.slice(before).some(frame => frame.type === 'response' && frame.requestId === requestId),
      () => 'command:' + command.type + ':frames=' + JSON.stringify(frames.map(frame => ({ type: frame.type,
        requestId: 'requestId' in frame ? frame.requestId : undefined }))));
    return (frames.slice(before).find(frame => frame.type === 'response' && frame.requestId === requestId) as { value: Result<T> }).value;
  } };
}

if (import.meta.main && process.argv[2] === '--run') {
  let releaseCredentials: (() => void) | undefined, releaseStopFacts: (() => void) | undefined;
  let releaseRecovery: (() => void) | undefined;
  const activationStats = { starts: 0, decrypts: 0 };
  if (process.argv[5] === 'observe-activation') {
    const { spyOn } = await import('bun:test');
    const storage = await import('../../packages/shared/src/service-secure-storage.ts'), secure = storage.createServiceSecureStorage;
    spyOn(storage, 'createServiceSecureStorage').mockImplementation(ownerSid => {
      const port = secure(ownerSid);
      return { ...port, async decrypt(ciphertext) { activationStats.decrypts++; return port.decrypt(ciphertext); } };
    });
    const host = await import('../../apps/host/dispatch.ts'), original = host.createProductCommandDispatcher;
    spyOn(host, 'createProductCommandDispatcher').mockImplementation(async options => {
      const created = await original(options);
      if (created.ok) {
        const start = created.data.startRecovery;
        created.data.startRecovery = (...args) => { activationStats.starts++; return start(...args); };
      }
      return created;
    });
  }
  if (process.argv[5] === 'hold-start-recovery' || process.argv[5] === 'fail-start-recovery') {
    const { spyOn } = await import('bun:test');
    const host = await import('../../apps/host/dispatch.ts'), original = host.createProductCommandDispatcher;
    const gate = new Promise<void>(resolve => { releaseRecovery = resolve; });
    spyOn(host, 'createProductCommandDispatcher').mockImplementation(async options => {
      const created = await original(options);
      if (created.ok) {
        const start = created.data.startRecovery;
        created.data.startRecovery = async (...args) => {
          process.stdout.write(JSON.stringify({ type: 'fixture_recovery_entered' }) + '\n');
          if (process.argv[5] === 'fail-start-recovery') return { ok: false, error: { code: 'service_credential_publication_pending',
            category: 'storage', retryable: true, message: 'The original publication is not yet confirmed.' } };
          await gate; return start(...args);
        };
      }
      return created;
    });
  }
  if (process.argv[5] === 'hold-credential-read') {
    const { spyOn } = await import('bun:test');
    const storage = await import('../../packages/shared/src/service-secure-storage.ts'), original = storage.createServiceSecureStorage;
    const gate = new Promise<void>(resolve => { releaseCredentials = resolve; });
    spyOn(storage, 'createServiceSecureStorage').mockImplementation(ownerSid => {
      const port = original(ownerSid);
      return { ...port, async decrypt(ciphertext) {
        process.stdout.write(JSON.stringify({ type: 'fixture_credential_waiting' }) + '\n'); await gate;
        return port.decrypt(ciphertext);
      } };
    });
  }
  if (process.argv[5] === 'hold-foreground-facts') {
    const { spyOn } = await import('bun:test');
    const host = await import('../../apps/host/dispatch.ts'), original = host.createProductCommandDispatcher;
    let held = true; releaseStopFacts = () => { held = false; };
    spyOn(host, 'createProductCommandDispatcher').mockImplementation(async options => {
      const created = await original(options);
      if (created.ok) {
        const read = created.data.readForegroundStop;
        created.data.readForegroundStop = async reference => held ? { ok: true, data: false } : read(reference);
      }
      return created;
    });
  }
  if (process.argv[5] === 'hold-close') {
    const { spyOn } = await import('bun:test');
    const personal = await import('../../apps/personal-agent.ts');
    const original = personal.createPersonalAgentRuntime;
    spyOn(personal, 'createPersonalAgentRuntime').mockImplementation(async options => {
      const created = await original(options);
      if (created.ok) {
        const close = created.data.close;
        let unconfirmed = true;
        created.data.close = async () => {
          const report = await close();
          if (unconfirmed) { unconfirmed = false; return { ok: false, error: { code: 'runtime_stop_unconfirmed',
            category: 'runtime', retryable: true, message: 'Original runtime stop is not yet confirmed.' } }; }
          return report;
        };
      }
      return created;
    });
  }
  const { createServiceOwner } = await import('../../apps/service/owner.ts');
  const created = await createServiceOwner({ installationFile: resolve(process.argv[3]!), runtimeRoot: resolve(process.argv[4]!) });
  if (!created.ok) throw Error(created.error.code);
  const owner = created.data;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', async line => {
    if (line === 'activation-stats') { process.stdout.write(JSON.stringify({ type: 'fixture_activation_stats', ...activationStats }) + '\n'); return; }
    if (line === 'release-recovery') { releaseRecovery?.(); return; }
    if (line === 'release-credentials') { releaseCredentials?.(); return; }
    if (line === 'release-stop-facts') { releaseStopFacts?.(); return; }
    if (line !== 'close') return;
    const report = await owner.close();
    process.stdout.write(JSON.stringify({ type: 'fixture_close', report }) + '\n');
    if (report.ok && report.data.closed && report.data.stopped) { input.close(); process.exitCode = 0; }
  });
  process.stdout.write(JSON.stringify({ type: 'fixture_ready' }) + '\n');
}
