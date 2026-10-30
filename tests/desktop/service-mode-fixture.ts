import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { packageOwnerFixture, installOwnerFixture, spawnOwnerFixture, removeOwnerFixture } from '../service/owner-fixture.ts';
import type { ServiceOwner } from '../../apps/service/owner.ts';

const mode = process.argv[2];
if (!['enabled', 'offline', 'pending', 'prepared', 'unknown-settings'].includes(mode ?? '')) throw Error('service_mode_fixture_invalid');
const packaged = await packageOwnerFixture();
let installation: Awaited<ReturnType<typeof installOwnerFixture>> | undefined;
let owner: Awaited<ReturnType<typeof spawnOwnerFixture>> | undefined;
let directOwner: ServiceOwner | undefined;
try {
  installation = await installOwnerFixture(packaged.runtimeRoot);
  const selected = { ...installation, enabled: mode === 'enabled' || mode === 'offline' || mode === 'unknown-settings',
    activationOperationId: mode === 'prepared' ? null : randomUUID() };
  writeFileSync(join(installation.dataRoot, 'service-installation.json'), JSON.stringify(selected));
  if (mode === 'enabled') owner = await spawnOwnerFixture(selected);
  if (mode === 'unknown-settings') {
    const files = await import('node:fs/promises'), actualFiles = { ...files }, { mock, spyOn } = await import('bun:test');
    let failedCommitReceipt = false, removedPublicationProof = false;
    const operationsRoot = join(selected.dataRoot, 'security/service-credentials/operations');
    mock.module('node:fs/promises', () => ({ ...actualFiles, rename: async (...paths: Parameters<typeof files.rename>) => {
      const target = String(paths[1]);
      if (target.startsWith(operationsRoot)) {
        const record = JSON.parse(await actualFiles.readFile(paths[0], 'utf8')) as { receipt?: { kind?: string; phase?: string; error?: { code?: string };
          models: Array<{ credentialRef: string }>; operationId: string } };
        if (record.receipt?.kind === 'settings' && record.receipt.phase === 'committed' && !failedCommitReceipt) {
          failedCommitReceipt = true; throw Object.assign(Error('controlled_final_receipt_write_failed'), { code: 'EIO' });
        }
        const renamed = await actualFiles.rename(...paths);
        if (!removedPublicationProof && record.receipt?.phase === 'failed' && record.receipt.error?.code === 'operation_result_unknown') {
          for (const model of record.receipt.models) {
            const file = join(selected.dataRoot, 'security/service-credentials', model.credentialRef + '.json');
            const envelope = JSON.parse(await actualFiles.readFile(file, 'utf8')); delete envelope.servicePublication;
            await actualFiles.writeFile(file, JSON.stringify(envelope));
          }
          removedPublicationProof = true;
          process.stdout.write(JSON.stringify({ type: 'fixture_unknown_settings_receipt', receipt: record.receipt }) + '\n');
        }
        return renamed;
      }
      return actualFiles.rename(...paths);
    } }));
    const credentials = await import('../../packages/core/src/configuration/service-credentials.ts'), createCredentials = credentials.createServiceCredentialService;
    spyOn(credentials, 'createServiceCredentialService').mockImplementation(ports => {
      const service = createCredentials(ports);
      return { ...service, saveSettings(input) {
        process.stdout.write(JSON.stringify({ type: 'fixture_settings_save', operationId: input.operationId }) + '\n'); return service.saveSettings(input);
      } };
    });
    const { createServiceOwner } = await import('../../apps/service/owner.ts');
    const opened = await createServiceOwner({ installationFile: join(selected.dataRoot, 'service-installation.json'), runtimeRoot: selected.runtimeRoot });
    if (!opened.ok) throw Error(opened.error.code); directOwner = opened.data;
  }
  process.stdout.write(JSON.stringify({ type: 'ready', installation: selected }) + '\n');
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line !== 'close') continue;
    if (directOwner) { const result = await directOwner.close(); if (!result.ok || !result.data.closed || !result.data.stopped) throw Error('service_mode_fixture_stop_unconfirmed'); directOwner = undefined; }
    if (owner) {
      const result = await owner.close();
      if (!result || !(result as { ok: boolean; data?: { closed: boolean; stopped: boolean } }).ok
        || !(result as { data: { closed: boolean; stopped: boolean } }).data.closed
        || !(result as { data: { closed: boolean; stopped: boolean } }).data.stopped) throw Error('service_mode_fixture_stop_unconfirmed');
      await owner.child.exited; owner = undefined;
    }
    input.close(); process.stdin.destroy(); break;
  }
} finally {
  if (directOwner) { const result = await directOwner.close(); if (!result.ok || !result.data.closed || !result.data.stopped) throw Error('service_mode_fixture_stop_unconfirmed'); }
  if (owner) { const result = await owner.close(); if (!(result as { ok: boolean; data?: { closed: boolean } }).ok
    || !(result as { data: { closed: boolean } }).data.closed) throw Error('service_mode_fixture_stop_unconfirmed'); await owner.child.exited; }
  if (installation) removeOwnerFixture(installation.dataRoot);
  removeOwnerFixture(packaged.root);
}
