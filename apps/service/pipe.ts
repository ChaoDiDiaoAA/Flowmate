import { readCurrentWindowsSid } from '../../packages/shared/src/windows-identity.ts';
import { servicePipeName } from './protocol.ts';
export { servicePipeName } from './protocol.ts';

const maxInboundFrameBytes = 1_100_000;
// Shared product replies include existing invoice originals: 14 MiB base64 plus bounded envelope metadata.
const maxOutboundFrameBytes = 14 * 1024 * 1024 + 64 * 1024;
const invalidHandle = 0xffffffffffffffffn;

export type ServicePipeConnection = {
  readonly peerSid: string;
  read(): Promise<unknown>;
  write(value: unknown): Promise<void>;
  close(): Promise<void>;
};
export type ServicePipeServer = {
  readonly name: string;
  accept(): Promise<ServicePipeConnection>;
  close(): Promise<void>;
};

async function loadWindowsPipe() {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw Error('pipe_windows_unavailable');
  const ffi = await import('bun:ffi');
  const kernel = ffi.dlopen('kernel32.dll', {
    CreateNamedPipeW: { args: ['buffer', 'u32', 'u32', 'u32', 'u32', 'u32', 'u32', 'buffer'], returns: 'u64' },
    ConnectNamedPipe: { args: ['u64', 'buffer'], returns: 'i32' },
    DisconnectNamedPipe: { args: ['u64'], returns: 'i32' },
    CreateEventW: { args: ['ptr', 'i32', 'i32', 'ptr'], returns: 'u64' },
    ReadFile: { args: ['u64', 'buffer', 'u32', 'buffer', 'buffer'], returns: 'i32' },
    WriteFile: { args: ['u64', 'buffer', 'u32', 'buffer', 'buffer'], returns: 'i32' },
    GetOverlappedResult: { args: ['u64', 'buffer', 'buffer', 'i32'], returns: 'i32' },
    CancelIoEx: { args: ['u64', 'ptr'], returns: 'i32' },
    GetCurrentThread: { args: [], returns: 'u64' },
    GetLastError: { args: [], returns: 'u32' },
    CloseHandle: { args: ['u64'], returns: 'i32' },
    LocalFree: { args: ['u64'], returns: 'u64' },
  });
  try {
    const security = ffi.dlopen('advapi32.dll', {
      ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ['buffer', 'u32', 'buffer', 'ptr'], returns: 'i32' },
      ImpersonateNamedPipeClient: { args: ['u64'], returns: 'i32' },
      OpenThreadToken: { args: ['u64', 'u32', 'i32', 'buffer'], returns: 'i32' },
      GetTokenInformation: { args: ['u64', 'u32', 'ptr', 'u32', 'buffer'], returns: 'i32' },
      ConvertSidToStringSidA: { args: ['u64', 'buffer'], returns: 'i32' },
      RevertToSelf: { args: [], returns: 'i32' },
    });
    return { ffi, kernel, security };
  } catch (error) { kernel.close(); throw error; }
}
type WindowsPipe = Awaited<ReturnType<typeof loadWindowsPipe>>;

class PipeIo {
  private closed = false;
  private closing: Promise<void> | null = null;
  private pending = new Set<Promise<number>>();
  constructor(readonly handle: bigint, private windows: WindowsPipe) {}
  get isClosed() { return this.closed; }

  run(kind: 'connect' | 'read' | 'write', buffer = Buffer.alloc(0)): Promise<number> {
    if (this.closed) return Promise.reject(Error('pipe_closed'));
    const api = this.windows.kernel.symbols;
    const event = api.CreateEventW(null, 1, 0, null);
    if (event === 0n) return Promise.reject(Error(`pipe_CreateEventW:${api.GetLastError()}`));
    const overlapped = Buffer.alloc(32), transferred = new Uint32Array(1);
    overlapped.writeBigUInt64LE(event, 24);
    const completion = (async () => {
      const started = kind === 'connect' ? api.ConnectNamedPipe(this.handle, overlapped)
        : kind === 'read' ? api.ReadFile(this.handle, buffer, buffer.length, transferred, overlapped)
          : api.WriteFile(this.handle, buffer, buffer.length, transferred, overlapped);
      const code = started ? 0 : api.GetLastError();
      if (kind === 'connect' && code === 535) return 0; // Client connected between creation and ConnectNamedPipe.
      if (started) return transferred[0]!;
      if (code !== 997) throw Error(`pipe_${kind}:${code}`);
      for (;;) {
        if (api.GetOverlappedResult(this.handle, overlapped, transferred, 0)) return transferred[0]!;
        const error = api.GetLastError();
        if (error !== 996) throw Error(this.closed ? 'pipe_closed' : `pipe_${kind}:${error}`);
        await Bun.sleep(5);
      }
    })();
    const tracked = completion.finally(() => { this.pending.delete(tracked); api.CloseHandle(event); });
    this.pending.add(tracked);
    return tracked;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const api = this.windows.kernel.symbols;
      if (!api.CancelIoEx(this.handle, null) && api.GetLastError() !== 1168) throw Error('pipe_cancel_failed');
      // Cancellation only requests termination; retain native buffers until I/O actually completes.
      await Promise.allSettled([...this.pending]);
      api.DisconnectNamedPipe(this.handle);
      if (!api.CloseHandle(this.handle)) throw Error('pipe_close_failed');
    })().catch(error => { this.closing = null; throw error; });
    return this.closing;
  }
}

function clientSid(windows: WindowsPipe, handle: bigint): string {
  const api = windows.security.symbols, kernel = windows.kernel.symbols;
  if (!api.ImpersonateNamedPipeClient(handle)) throw Error(`pipe_impersonation_failed:${kernel.GetLastError()}`);
  const token = new BigUint64Array(1), sidText = new BigUint64Array(1);
  try {
    if (!api.OpenThreadToken(kernel.GetCurrentThread(), 8, 1, token)) throw Error(`pipe_token_failed:${kernel.GetLastError()}`);
    const bytes = new Uint32Array(1);
    api.GetTokenInformation(token[0]!, 1, null, 0, bytes);
    if (kernel.GetLastError() !== 122 || bytes[0]! < 16) throw Error('pipe_token_size_invalid');
    const user = new BigUint64Array(Math.ceil(bytes[0]! / 8));
    if (!api.GetTokenInformation(token[0]!, 1, windows.ffi.ptr(user), user.byteLength, bytes)
      || !api.ConvertSidToStringSidA(user[0]!, sidText)) throw Error('pipe_sid_unavailable');
    return new windows.ffi.CString(Number(sidText[0]) as import('bun:ffi').Pointer);
  } finally {
    // Continuing after a failed revert would run the service as its client.
    if (!api.RevertToSelf()) process.abort();
    if (sidText[0]) kernel.LocalFree(sidText[0]);
    if (token[0]) kernel.CloseHandle(token[0]);
  }
}

function connectionFor(io: PipeIo, windows: WindowsPipe, ownerSid: string, first: Buffer, released: () => void): ServicePipeConnection {
  let buffered = first, closed = false, reading = false;
  let closing: Promise<void> | null = null, writes = Promise.resolve();
  const close = () => {
    if (closing) return closing;
    closed = true;
    closing = io.close().then(released).catch(error => { closing = null; throw error; });
    return closing;
  };
  return {
    peerSid: ownerSid,
    async read() {
      if (closed || io.isClosed) throw Error('pipe_closed');
      if (reading) throw Error('pipe_read_pending');
      reading = true;
      try {
        for (;;) {
          if (closed || io.isClosed) throw Error('pipe_closed');
          const end = buffered.indexOf(10);
          if (end >= 0) {
            if (end > maxInboundFrameBytes) throw Error('pipe_frame_too_large');
            const frame = buffered.subarray(0, end); buffered = buffered.subarray(end + 1);
            try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)) as unknown; }
            catch { throw Error('pipe_frame_invalid'); }
          }
          if (buffered.length > maxInboundFrameBytes) throw Error('pipe_frame_too_large');
          const chunk = Buffer.alloc(8192);
          let bytes: number;
          try { bytes = await io.run('read', chunk); }
          catch (error) {
            if (error instanceof Error && /pipe_read:(109|232|233)$/.test(error.message))
              throw Error(buffered.length ? 'pipe_frame_truncated' : 'pipe_disconnected');
            throw error;
          }
          if (!bytes) throw Error(buffered.length ? 'pipe_frame_truncated' : 'pipe_disconnected');
          if (closed || io.isClosed) throw Error('pipe_closed');
          if (clientSid(windows, io.handle) !== ownerSid) throw Error('pipe_client_forbidden');
          buffered = Buffer.concat([buffered, chunk.subarray(0, bytes)]);
        }
      } catch (error) { await close(); throw error; }
      finally { reading = false; }
    },
    async write(value) {
      if (closed || io.isClosed) throw Error('pipe_closed');
      let json: string | undefined;
      try { json = JSON.stringify(value); } catch { throw Error('pipe_frame_invalid'); }
      if (json === undefined) throw Error('pipe_frame_invalid');
      const frame = Buffer.from(json + '\n', 'utf8');
      if (frame.length - 1 > maxOutboundFrameBytes) throw Error('pipe_frame_too_large');
      const written = writes.then(async () => {
        if (closed) throw Error('pipe_closed');
        for (let offset = 0; offset < frame.length;) {
          const bytes = await io.run('write', frame.subarray(offset));
          if (!bytes) throw Error('pipe_write_failed');
          offset += bytes;
        }
      });
      writes = written.catch(() => {});
      try { await written; } catch (error) { await close(); throw error; }
    },
    close,
  };
}

/** Installation identity locates the pipe; only Windows token identity grants access. */
export async function createServicePipeServer({ installationId, ownerSid }: { installationId: string; ownerSid: string }): Promise<ServicePipeServer> {
  const name = servicePipeName(installationId);
  const identity = await readCurrentWindowsSid();
  if (!identity.ok) throw Error('pipe_identity_unavailable');
  if (identity.data !== ownerSid) throw Error('pipe_owner_mismatch');
  const windows = await loadWindowsPipe();
  const api = windows.kernel.symbols, descriptor = new BigUint64Array(1);
  const instances = new Set<PipeIo>();
  let listener: PipeIo | null = null, accepting: Promise<ServicePipeConnection> | null = null;
  let closed = false, closing: Promise<void> | null = null;
  try {
    const sddl = Buffer.from(`O:${ownerSid}D:P(A;;GA;;;SY)(A;;GA;;;${ownerSid})\0`, 'utf16le');
    if (!windows.security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, descriptor, null))
      throw Error(`pipe_security_descriptor_failed:${api.GetLastError()}`);
    const attributes = Buffer.alloc(24); attributes.writeUInt32LE(24, 0); attributes.writeBigUInt64LE(descriptor[0]!, 8);
    function createInstance(first: boolean) {
      const handle = api.CreateNamedPipeW(Buffer.from(name + '\0', 'utf16le'),
        3 | 0x40000000 | (first ? 0x80000 : 0), 8, 255, 65536, 65536, 0, attributes);
      if (handle === invalidHandle) throw Error(`pipe_CreateNamedPipeW:${api.GetLastError()}`);
      const io = new PipeIo(handle, windows); instances.add(io); return io;
    }
    listener = createInstance(true);
    return {
      name,
      accept() {
        if (closed) return Promise.reject(Error('pipe_closed'));
        if (!listener) return Promise.reject(Error('pipe_listener_unavailable'));
        if (accepting) return Promise.reject(Error('pipe_accept_pending'));
        const candidate = listener;
        const accepted = (async () => {
          try {
            await candidate.run('connect');
            if (closed) throw Error('pipe_closed');
            // Keep a listening instance alive before releasing any connected instance's name ownership.
            listener = null; listener = createInstance(false);
            const first = Buffer.alloc(1);
            let firstByteTimer: ReturnType<typeof setTimeout> | undefined, bytes: number;
            try {
              // Authenticate only after real data; silence must not hold the accept loop indefinitely.
              bytes = await Promise.race([candidate.run('read', first), new Promise<number>((_, reject) => {
                firstByteTimer = setTimeout(() => reject(Error('pipe_first_byte_timeout')), 5000);
              })]);
            } finally { clearTimeout(firstByteTimer); }
            if (!bytes) throw Error('pipe_disconnected');
            const peerSid = clientSid(windows, candidate.handle);
            if (peerSid !== ownerSid) throw Error('pipe_client_forbidden');
            return connectionFor(candidate, windows, peerSid, first, () => instances.delete(candidate));
          } catch (error) {
            if (!closed && listener === candidate) { listener = null; listener = createInstance(false); }
            await candidate.close(); instances.delete(candidate); throw error;
          }
        })();
        accepting = accepted;
        void accepted.then(() => { accepting = null; }, () => { accepting = null; });
        return accepted;
      },
      close() {
        if (closing) return closing;
        closed = true;
        closing = (async () => {
          const results = await Promise.allSettled([...instances].map(io => io.close()));
          if (accepting) await accepting.catch(() => {});
          const failure = results.find(result => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;
          instances.clear(); api.LocalFree(descriptor[0]!); windows.security.close(); windows.kernel.close();
        })().catch(error => { closing = null; throw error; });
        return closing;
      },
    };
  } catch (error) {
    await Promise.allSettled([...instances].map(io => io.close()));
    if (descriptor[0]) api.LocalFree(descriptor[0]);
    windows.security.close(); windows.kernel.close(); throw error;
  }
}
