import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createProduct } from '../apps/composition.ts';
import { assertNoLinkedAncestors } from '../packages/core/src/storage/file-store.ts';
import { readRecoveryCheckpoint } from '../apps/recovery.ts';
import type { ArtifactRef, DocumentRef, ParseSelection, Purpose } from '../packages/contracts/src/index.ts';

type Args = Record<string, string | boolean>;

async function main(argv: string[]): Promise<void> {
  const [command = '', ...rest] = argv;
  const args = parseArgs(rest);
  const instanceRoot = required(args, 'instance-root');
  if (command === 'checkpoint') { print(await readRecoveryCheckpoint(instanceRoot)); return; }
  const mode = command === 'init' ? 'create' : 'open';
  const recoveryCheckpoint = typeof args['recovery-checkpoint'] === 'string' ? await readJson<import('../packages/contracts/src/index.ts').RecoveryCheckpoint>(args['recovery-checkpoint']) : undefined;
  const product = await createProduct({ instanceRoot, mode, ...(typeof args.config === 'string' ? { configPath: args.config } : {}), ...(recoveryCheckpoint ? { recoveryCheckpoint } : {}) });
  try {
    const requestId = String(args['request-id'] ?? crypto.randomUUID());
    const req = { requestId, workspaceId: product.workspaceId };
    const purpose = (args.purpose ?? 'development') as Purpose;
    switch (command) {
      case 'init':
        print({ instanceId: product.instanceId, workspaceId: product.workspaceId, processInstanceId: product.processInstanceId });
        break;
      case 'inspect':
        print(await product.application.inspectSource(req, { sourceKey: String(args['source-key'] ?? 'voxel51'), manifestSha256: required(args, 'manifest-sha256'), purpose }));
        break;
      case 'register-document':
        print(await product.application.registerSourceDocument(req, { sourceKey: String(args['source-key'] ?? 'voxel51'), sampleId: required(args, 'sample-id'), manifestSha256: required(args, 'manifest-sha256'), purpose }));
        break;
      case 'publish': {
        const selection = args.selection ? await readJson<ParseSelection[]>(String(args.selection)) : [];
        print(await product.application.publishDataset(req, { sourceKey: String(args['source-key'] ?? 'voxel51'), manifestSha256: required(args, 'manifest-sha256'), selection, purpose }));
        break;
      }
      case 'read': {
        const document = await readJson<DocumentRef>(required(args, 'document-ref'));
        const manifest = await readJson<ArtifactRef>(required(args, 'manifest-ref'));
        const projection = await product.application.readDocument(req, { document, manifest, purpose });
        print({ schemaVersion: projection.schemaVersion, document: projection.document, contentHash: projection.parsed.contentHash, pages: projection.parsed.pages.length, evidenceCount: projection.evidence.length });
        break;
      }
      case 'capture': {
        const document = await readJson<DocumentRef>(required(args, 'document-ref'));
        const manifest = await readJson<ArtifactRef>(required(args, 'manifest-ref'));
        print(await product.application.captureInput(req, { document, manifest, purpose }));
        break;
      }
      case 'read-captured': {
        const projection = await readJson<ArtifactRef>(required(args, 'projection-ref'));
        const input = await product.application.readCapturedInput(req, { projection, purpose });
        print({ schemaVersion: input.schemaVersion, document: input.document, contentHash: input.parsed.contentHash, pages: input.parsed.pages.length, evidenceCount: input.evidence.length, instanceId: product.instanceId, workspaceId: product.workspaceId, processInstanceId: product.processInstanceId, pid: process.pid });
        break;
      }
      case 'workspace-status': {
        if (!args['target-status']) print(await product.application.getWorkspace(req));
        else print(await product.application.setWorkspaceStatus(req, { expectedStatus: required(args, 'expected-status') as 'active' | 'paused' | 'archived', expectedRevision: Number(required(args, 'expected-revision')), targetStatus: String(args['target-status']) as 'active' | 'paused' | 'archived', reason: required(args, 'reason') }));
        break;
      }
      case 'document-status': {
        const document = await readJson<DocumentRef>(required(args, 'document-ref'));
        print(await product.application.setDocumentStatus(req, { document, change: { expectedStatus: required(args, 'expected-status') as 'pending' | 'available' | 'unavailable' | 'withdrawn', expectedRevision: Number(required(args, 'expected-revision')), targetStatus: required(args, 'target-status') as 'pending' | 'available' | 'unavailable' | 'withdrawn', reason: required(args, 'reason') } }));
        break;
      }
      case 'receipt':
        print(await product.application.findReceipt(req, { originalRequestId: required(args, 'original-request-id') }));
        break;
      case 'policy-publish':
        print(await product.application.publishPolicy(req, { expectedRevision: Number(required(args, 'expected-revision')), policy: await readJson(required(args, 'policy')) }));
        break;
      default:
        throw new Error(`Unknown P0 command: ${command}`);
    }
  } finally {
    const closed = await product.close();
    if (!closed.closed || closed.cleanupErrors.length > 0) throw Object.assign(new Error('Flowmate closed with cleanup errors'), { cleanupErrors: closed.cleanupErrors });
  }
}

function parseArgs(values: string[]): Args {
  const result: Args = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) result[key] = true;
    else { result[key] = next; index += 1; }
  }
  return result;
}

function required(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing --${name}`);
  return value;
}

async function readJson<T>(path: string): Promise<T> {
  const resolved = resolve(path);
  if (resolved.split(/[\\/]+/).some((part) => part.toLowerCase() === 'agent-eval')) throw new Error('Quality and evaluation files are not valid product command inputs');
  await assertNoLinkedAncestors(resolved);
  return JSON.parse(await readFile(resolved, 'utf8')) as T;
}
function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

main(process.argv.slice(2)).catch((error) => {
  const descriptor = error && typeof error === 'object' && 'descriptor' in error ? (error as { descriptor: unknown }).descriptor : { code: 'CLI_FAILED', message: error instanceof Error ? error.message : String(error) };
  const cleanupErrors = error && typeof error === 'object' && 'cleanupErrors' in error ? error.cleanupErrors : undefined;
  process.stderr.write(`${JSON.stringify({ ...(descriptor as object), ...(cleanupErrors ? { cleanupErrors } : {}) })}\n`);
  process.exitCode = 1;
});
