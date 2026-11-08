import { z } from 'zod';

export async function verifyOpenVikingIdentity(input: { endpoint: string; apiKey: string; accountId?: string; userId?: string;
  role: 'user' | 'admin' | 'root'; fetch: typeof fetch; signal?: AbortSignal | null }): Promise<boolean> {
  try {
    const health = await input.fetch(new URL('/health', input.endpoint), { redirect: 'error',
      headers: { 'X-API-Key': input.apiKey }, signal: input.signal ?? AbortSignal.timeout(10000) });
    if (!health.ok || !health.body) return false;
    const reader = health.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      total += next.value.byteLength; if (total > 8192) { await reader.cancel(); return false; }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const identity = z.object({ status: z.literal('ok'), version: z.literal('0.4.23'), auth_mode: z.literal('api_key'),
      role: z.string(), account_id: z.string(), user_id: z.string() }).passthrough()
      .parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return identity.role === input.role && (input.role === 'root' || identity.account_id === input.accountId)
      && (input.userId === undefined || identity.user_id === input.userId);
  } catch { return false; }
}
