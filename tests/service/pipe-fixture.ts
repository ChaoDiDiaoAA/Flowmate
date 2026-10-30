import { createConnection } from 'node:net';
import { once } from 'node:events';

const [mode, name, encoded = ''] = process.argv.slice(2);
if (!mode || !name) throw Error('pipe_fixture_arguments');

if (mode === 'cancel-client-failure' || mode === 'cancel-server-failure') {
  const { mock } = await import('bun:test');
  const ffi = await import('bun:ffi'), originalDlopen = ffi.dlopen;
  const native = originalDlopen('kernel32.dll', {
    SetLastError: { args: ['u32'], returns: 'void' },
    GetLastError: { args: [], returns: 'u32' },
    CancelIoEx: { args: ['u64', 'ptr'], returns: 'i32' },
    GetOverlappedResult: { args: ['u64', 'buffer', 'buffer', 'i32'], returns: 'i32' },
    CloseHandle: { args: ['u64'], returns: 'i32' },
  });
  const heldLibraries = new Set<() => void>();
  let failedHandle = 0n, cancellationAttempts = 0, nativeStopped = false, prematureUnloads = 0;
  const dlopen: typeof ffi.dlopen = (filename, definitions) => {
    const library = originalDlopen(filename, definitions);
    if ('CancelIoEx' in definitions) {
      Reflect.set(library.symbols, 'CancelIoEx', (handle: bigint, overlapped: import('bun:ffi').Pointer | null) => {
        if (failedHandle === 0n) { failedHandle = handle; cancellationAttempts++; native.symbols.SetLastError(5); return 0; }
        if (handle === failedHandle) cancellationAttempts++;
        return native.symbols.CancelIoEx(handle, overlapped);
      });
      Reflect.set(library.symbols, 'GetOverlappedResult', (handle: bigint, overlapped: Buffer, transferred: Uint32Array, wait: number) => {
        const completed = native.symbols.GetOverlappedResult(handle, overlapped, transferred, wait);
        if (handle === failedHandle && (completed || native.symbols.GetLastError() !== 996)) nativeStopped = true;
        return completed;
      });
    }
    if ('CancelIoEx' in definitions || 'ConvertStringSecurityDescriptorToSecurityDescriptorW' in definitions) {
      const close = library.close.bind(library);
      const release = () => { close(); heldLibraries.delete(release); };
      heldLibraries.add(release);
      Reflect.set(library, 'close', () => {
        // Keep a failing implementation's real pending I/O safe while detecting its premature unload.
        if (failedHandle !== 0n && !nativeStopped) { prematureUnloads++; return; }
        release();
      });
    }
    return library;
  };
  mock.module('bun:ffi', () => ({ ...ffi, dlopen }));
  const { createServicePipeServer } = await import('../../apps/service/pipe.ts');
  const { readCurrentWindowsSid } = await import('../../packages/shared/src/windows-identity.ts');
  const identity = await readCurrentWindowsSid(); if (!identity.ok) throw Error('pipe_fixture_identity');
  const server = await createServicePipeServer({ installationId: crypto.randomUUID(), ownerSid: identity.data });
  const accepted = server.accept(), client = createConnection(server.name);
  client.on('error', () => {});
  let pendingRead: Promise<unknown> | null = null, cleaned = false;
  try {
    await once(client, 'connect'); client.write('{');
    const connection = await accepted;
    pendingRead = connection.read().catch(error => error);
    const firstError = await (mode === 'cancel-server-failure' ? server.close() : connection.close())
      .then(() => null, (error: Error) => error.message);
    Bun.gc(true);
    const retryError = await server.close().then(() => null, (error: Error) => error.message);
    const connectionRetry = await connection.close().then(() => true, () => false);
    cleaned = retryError === null && nativeStopped && prematureUnloads === 0;
    console.log(JSON.stringify({ firstError, retryError, connectionRetry, cancellationAttempts,
      nativeStopped, prematureUnloads }));
  } finally {
    if (!cleaned && failedHandle !== 0n) {
      native.symbols.CancelIoEx(failedHandle, null);
      await pendingRead;
      native.symbols.CloseHandle(failedHandle);
    } else await pendingRead;
    client.destroy();
    for (const release of [...heldLibraries]) release();
    native.close();
  }
} else if (mode === 'security') {
  const { dlopen, CString } = await import('bun:ffi');
  const kernel = dlopen('kernel32.dll', {
    CreateFileW: { args: ['buffer', 'u32', 'u32', 'ptr', 'u32', 'u32', 'u64'], returns: 'u64' },
    CloseHandle: { args: ['u64'], returns: 'i32' },
    LocalFree: { args: ['u64'], returns: 'u64' },
  });
  const security = dlopen('advapi32.dll', {
    GetSecurityInfo: { args: ['u64', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr', 'buffer'], returns: 'u32' },
    ConvertSecurityDescriptorToStringSecurityDescriptorA: { args: ['u64', 'u32', 'u32', 'buffer', 'ptr'], returns: 'i32' },
  });
  let handle = 0n;
  const descriptor = new BigUint64Array(1), sddl = new BigUint64Array(1);
  try {
    handle = kernel.symbols.CreateFileW(Buffer.from(name + '\0', 'utf16le'), 0x20000, 0, null, 3, 0, 0n);
    if (handle === 0xffffffffffffffffn) throw Error('pipe_fixture_open');
    const status = security.symbols.GetSecurityInfo(handle, 6, 4, null, null, null, null, descriptor);
    if (status !== 0) throw Error(`pipe_fixture_security:${status}`);
    if (!security.symbols.ConvertSecurityDescriptorToStringSecurityDescriptorA(descriptor[0]!, 1, 4, sddl, null))
      throw Error('pipe_fixture_sddl');
    console.log(JSON.stringify({ sddl: new CString(Number(sddl[0]) as import('bun:ffi').Pointer) }));
  } finally {
    if (sddl[0]) kernel.symbols.LocalFree(sddl[0]);
    if (descriptor[0]) kernel.symbols.LocalFree(descriptor[0]);
    if (handle !== 0n && handle !== 0xffffffffffffffffn) kernel.symbols.CloseHandle(handle);
    security.close(); kernel.close();
  }
} else {
  const client = createConnection(name);
  client.on('error', () => { /* a rejected or closed connection has no business result */ });
  try {
    await once(client, 'connect');
    const raw = mode === 'oversized' ? Buffer.from('"' + '界'.repeat(370_000) + '"\n', 'utf8')
      : mode === 'large-exchange' ? Buffer.from(JSON.stringify({ version: 1, requestId: 'history-page',
        result: { ok: true, data: { text: 'h'.repeat(1_048_576) } } }) + '\n', 'utf8')
      : mode === 'image-response' ? Buffer.from(JSON.stringify({ version: 1, requestId: 'original-image',
        type: 'read_document_original', documentId: 11, page: 1 }) + '\n', 'utf8')
      : mode === 'invalid-utf8' ? Buffer.from([0xc3, 0x28, 10]) : Buffer.from(encoded, 'base64');
    if (mode === 'disconnect') {
      if (raw.length) await new Promise<void>((resolve, reject) => client.write(raw, error => error ? reject(error) : resolve()));
      client.destroy();
    } else {
      // Split even the UTF-8 text across writes; the wire contract is a byte stream.
      for (let offset = 0; offset < raw.length; offset += 4093) client.write(raw.subarray(offset, offset + 4093));
      if (mode === 'exchange' || mode === 'large-exchange' || mode === 'image-response') {
        let received = '';
        for await (const chunk of client) {
          received += chunk.toString('utf8');
          if (mode === 'image-response' && received.includes('\n')) {
            const response = JSON.parse(received.slice(0, received.indexOf('\n'))) as {
              version: number; requestId: string; result: { ok: true; data: import('@flowmate/contracts').DocumentOriginalImage } };
            const image = response.result.data;
            console.log(JSON.stringify({ requestId: response.requestId, documentId: image.documentRef.id,
              documentVersion: image.documentRef.version, mimeType: image.mimeType, base64Bytes: Buffer.byteLength(image.base64, 'utf8'),
              base64Matches: image.base64 === 'AAAA'.repeat(700_000) })); break;
          }
          if (mode === 'large-exchange' && received.includes('\n')) {
            const line = received.slice(0, received.indexOf('\n'));
            console.log(JSON.stringify({ matches: line === raw.toString('utf8').trimEnd(), bytes: Buffer.byteLength(line, 'utf8') })); break;
          }
          if (received.split('\n').length >= 3) { process.stdout.write(received); break; }
        }
      } else {
        client.resume();
        await new Promise<void>(resolve => client.once('close', () => resolve()));
      }
    }
  } finally { client.destroy(); }
}
