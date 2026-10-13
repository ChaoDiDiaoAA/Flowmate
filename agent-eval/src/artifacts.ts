/** Public evaluation artifacts use IDs and versions; integrity digests stay in memory. */
export function withoutHashes(value: unknown): any {
    if (value instanceof Error) return withoutHashes(String(value));
    if (Array.isArray(value)) return value.map(withoutHashes);
    if (value && typeof value === 'object') {
        const result=Object.fromEntries(Object.entries(value)
        .filter(([key,item]) => !/(hash|sha256|sha512|fingerprint|digest)|^sha$/i.test(key) &&
            !(key==='commit'&&typeof item==='string'&&/^[a-f0-9]{40,64}$/i.test(item)))
        .map(([key, item]) => [key, withoutHashes(item)]));
        if(result.tool&&typeof result.bytes==='number')result.bytes=Buffer.byteLength(JSON.stringify(result.tool));
        return result;
    }
    if (typeof value === 'string') {
        // Judge requests and tool arguments can themselves contain serialized JSON.
        if (/^[\s]*[\[{]/.test(value)) {
            try { return JSON.stringify(withoutHashes(JSON.parse(value))); } catch { /* ordinary source text */ }
        }
        return value.replace(/\b[a-f0-9]{40,64}\b/gi, '[omitted]');
    }
    return value;
}
export const artifactJson = (value: unknown) => JSON.stringify(withoutHashes(value), null, 2) + '\n';
