import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { appError, CLOUD_RESOURCE_CHUNK_BYTES, CloudResourceChunkSchema, CloudResourceExportChunkSchema, CloudResourceExportPrepareSchema,
  CloudResourceManifestSchema, CloudResourceReceiptSchema, CloudResourceStatusSchema, cloudDesktopFailure, fail, ok,
  parseCloudDesktopResult, parseCloudResourceExportResult, type CloudDesktopCommand, type CloudResourceExportCommand,
  type CloudResourceReceipt, type ResourceRef, type Result } from '@flowmate/contracts';
import type { CloudResourceExport } from '../../cloud-resource-export.ts';
import type { CloudSshSession } from './cloud-ssh-session.ts';
import type { HostClient } from './host-client.ts';
import type { ServiceClient } from './service-client.ts';

export function createHostCloudResourceExport(host: Pick<HostClient | ServiceClient, 'request'>): Pick<CloudResourceExport, 'prepare' | 'chunk' | 'complete'> {
  const call = async <T>(command: CloudResourceExportCommand, schema: z.ZodType<T>): Promise<Result<T>> => {
    try {
      const value = parseCloudResourceExportResult(command, await host.request(command));
      if (!value) throw Error('invalid_host_result');
      if (!value.ok) return value;
      const checked = schema.safeParse(value.data); if (checked.success) return ok(checked.data);
    } catch { /* Keep the original upload identity for a later retry. */ }
    return fail(appError('cloud_resource_unavailable', 'storage', 'The local resource result could not be confirmed.', true));
  };
  const invalid = () => fail(appError('input_invalid', 'input', 'The local resource request is invalid.'));
  return {
    prepare: raw => { const input = CloudResourceExportPrepareSchema.safeParse(raw);
      return input.success ? call({ type: 'cloud_resource_export_prepare', input: input.data },
        z.object({ manifest: CloudResourceManifestSchema, receipt: CloudResourceReceiptSchema.nullable() }).strict()) : Promise.resolve(invalid()); },
    chunk: raw => { const input = CloudResourceExportChunkSchema.safeParse(raw);
      return input.success ? call({ type: 'cloud_resource_export_chunk', input: input.data }, CloudResourceChunkSchema) : Promise.resolve(invalid()); },
    complete: raw => { const input = CloudResourceReceiptSchema.safeParse(raw);
      return input.success ? call({ type: 'cloud_resource_export_complete', input: input.data }, CloudResourceReceiptSchema) : Promise.resolve(invalid()); },
  };
}

/** Re-send the original chunks so Authority compares the already received bytes. */
export async function uploadCloudResource(input: { workspaceId: string; ref: ResourceRef },
  local: Pick<CloudResourceExport, 'prepare' | 'chunk' | 'complete'>,
  remote: Pick<CloudSshSession, 'request'>): Promise<Result<CloudResourceReceipt>> {
  const prepared = await local.prepare(input); if (!prepared.ok) return prepared;
  const { manifest } = prepared.data, key = { workspaceId: manifest.workspaceId, uploadId: manifest.uploadId };
  const request = async (command: CloudDesktopCommand): Promise<Result<unknown>> => {
    try { return parseCloudDesktopResult(command, await remote.request(command)) ?? cloudDesktopFailure(command); }
    catch { return cloudDesktopFailure(command); }
  };
  const begin = await request({ type: 'cloud_resource_begin', input: manifest }); if (!begin.ok) return begin;
  const observed = await request({ type: 'cloud_resource_status', input: key }); if (!observed.ok) return observed;
  const status = CloudResourceStatusSchema.safeParse(observed.data);
  if (!status.success || status.data.files.length !== manifest.manifest.files.length || manifest.manifest.files.some(file => {
    const current = status.data.files.find(item => item.path === file.path);
    return !current || current.offset > file.bytes || current.offset < file.bytes && current.offset % CLOUD_RESOURCE_CHUNK_BYTES !== 0
      || status.data.status === 'completed' && current.offset !== file.bytes;
  })) return fail(appError('state_conflict', 'input', 'The original resource upload progress differs.'));
  for (const file of manifest.manifest.files) for (let offset = 0; offset < file.bytes; offset += CLOUD_RESOURCE_CHUNK_BYTES) {
    const chunk = await local.chunk({ ...key, path: file.path, offset }); if (!chunk.ok) return chunk;
    const sent = await request({ type: 'cloud_resource_append', input: chunk.data }); if (!sent.ok) return sent;
  }
  const finished = await request({ type: 'cloud_resource_finish', input: key }); if (!finished.ok) return finished;
  const receipt = CloudResourceReceiptSchema.safeParse(finished.data);
  if (!receipt.success || !isDeepStrictEqual(receipt.data.ref, manifest.ref)
    || status.data.receipt && !isDeepStrictEqual(status.data.receipt, receipt.data)
    || prepared.data.receipt && !isDeepStrictEqual(prepared.data.receipt, receipt.data))
    return fail(appError('state_conflict', 'input', 'The original cloud resource receipt differs.'));
  return local.complete(receipt.data);
}
