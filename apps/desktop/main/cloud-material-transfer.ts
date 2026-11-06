import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CLOUD_MATERIAL_CHUNK_BYTES, CloudMaterialChunkSchema, CloudMaterialExportChunkSchema, CloudMaterialExportPrepareSchema,
  CloudMaterialManifestSchema, CloudMaterialReceiptSchema, CloudMaterialStatusSchema, cloudDesktopFailure, fail, ok,
  parseCloudDesktopResult, parseCloudMaterialExportResult, type CloudDesktopCommand, type CloudMaterialExportCommand,
  type CloudMaterialReceipt, type DocumentRef, type Result } from '@flowmate/contracts';
import type { CloudMaterialExport } from '../../cloud-material-export.ts';
import type { CloudSshSession } from './cloud-ssh-session.ts';
import type { HostClient } from './host-client.ts';
import type { ServiceClient } from './service-client.ts';

/** The product Host remains the only owner of its database and managed files. */
export function createHostCloudMaterialExport(host: Pick<HostClient | ServiceClient, 'request'>): Pick<CloudMaterialExport, 'prepare' | 'chunk' | 'complete'> {
  const call = async <T>(command: CloudMaterialExportCommand, schema: z.ZodType<T>): Promise<Result<T>> => {
    try {
      const value = parseCloudMaterialExportResult(command, await host.request(command));
      if (!value) throw Error('invalid_host_result');
      if (!value.ok) return value;
      const checked = schema.safeParse(value.data);
      if (checked.success) return ok(checked.data);
    } catch { /* A lost Host receipt is queried using the same upload identity. */ }
    return fail(appError('cloud_material_unavailable', 'storage', 'The local material result could not be confirmed.', true));
  };
  const invalid = () => fail(appError('input_invalid', 'input', 'The local material request is invalid.'));
  return {
    prepare: raw => {
      const input = CloudMaterialExportPrepareSchema.safeParse(raw);
      return input.success ? call({ type: 'cloud_material_export_prepare', input: input.data },
        z.object({ manifest: CloudMaterialManifestSchema, receipt: CloudMaterialReceiptSchema.nullable() }).strict()) : Promise.resolve(invalid());
    },
    chunk: raw => {
      const input = CloudMaterialExportChunkSchema.safeParse(raw);
      return input.success ? call({ type: 'cloud_material_export_chunk', input: input.data }, CloudMaterialChunkSchema) : Promise.resolve(invalid());
    },
    complete: raw => {
      const input = CloudMaterialReceiptSchema.safeParse(raw);
      return input.success ? call({ type: 'cloud_material_export_complete', input: input.data }, CloudMaterialReceiptSchema) : Promise.resolve(invalid());
    },
  };
}

/** Replays the same bounded chunks so Authority compares every previously received original byte. */
export async function uploadCloudMaterial(input: { workspaceId: string; documentRef: DocumentRef },
  local: Pick<CloudMaterialExport, 'prepare' | 'chunk' | 'complete'>,
  remote: Pick<CloudSshSession, 'request'>): Promise<Result<CloudMaterialReceipt>> {
  const prepared = await local.prepare(input); if (!prepared.ok) return prepared;
  const { manifest } = prepared.data;
  const request = async (command: CloudDesktopCommand): Promise<Result<unknown>> => {
    try { return parseCloudDesktopResult(command, await remote.request(command)) ?? cloudDesktopFailure(command); }
    catch { return cloudDesktopFailure(command); }
  };
  const begin = await request({ type: 'cloud_material_begin', input: manifest }); if (!begin.ok) return begin;
  const key = { workspaceId: manifest.workspaceId, uploadId: manifest.uploadId };
  const observed = await request({ type: 'cloud_material_status', input: key }); if (!observed.ok) return observed;
  const parsed = CloudMaterialStatusSchema.safeParse(observed.data);
  if (!parsed.success) return fail(appError('state_conflict', 'input', 'The original upload progress is invalid.'));
  const status = parsed.data;
  if (status.files.length !== manifest.files.length || manifest.files.some(file => {
    const received = status.files.find(item => item.kind === file.kind && item.name === file.name);
    return !received || received.offset > file.bytes || received.offset < file.bytes && received.offset % CLOUD_MATERIAL_CHUNK_BYTES !== 0
      || status.status === 'completed' && received.offset !== file.bytes;
  })) return fail(appError('state_conflict', 'input', 'The original upload progress differs from the local material.'));
  for (const file of manifest.files) for (let offset = 0; offset < file.bytes; offset += CLOUD_MATERIAL_CHUNK_BYTES) {
    const chunk = await local.chunk({ ...key, kind: file.kind, name: file.name, offset }); if (!chunk.ok) return chunk;
    const sent = await request({ type: 'cloud_material_append', input: chunk.data }); if (!sent.ok) return sent;
  }
  const finished = await request({ type: 'cloud_material_finish', input: key }); if (!finished.ok) return finished;
  const receipt = CloudMaterialReceiptSchema.safeParse(finished.data);
  if (!receipt.success || status.receipt && !isDeepStrictEqual(status.receipt, receipt.data)
    || prepared.data.receipt && !isDeepStrictEqual(prepared.data.receipt, receipt.data))
    return fail(appError('state_conflict', 'input', 'The original cloud material receipt differs.'));
  return local.complete(receipt.data);
}
