/** Public evaluation artifacts use IDs and versions; integrity digests stay in memory. */
export function withoutHashes(value: unknown): any {
    if (value instanceof Error) return withoutHashes(String(value));
    if (Array.isArray(value)) return value.map(withoutHashes);
    if (value && typeof value === 'object') {
        const result=Object.fromEntries(Object.entries(value)
        .filter(([key,item]) => !/(hash|sha256|sha512|fingerprint|digest)|^sha$/i.test(key) &&
            !(key==='commit'&&typeof item==='string'&&/^[a-f0-9]{40,64}$/i.test(item)))
        .map(([key, item]) => [key, key==='raw'&&'callId' in value&&typeof value.callId==='string'&&typeof item==='string'
            ? publicJudgeWire(item) : withoutHashes(item)]));
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
/** Keep malformed wire keys observable while replacing digest values, so readback preserves protocol errors. */
function publicJudgeWire(raw:string):string {
    const redact=(value:any):any=>Array.isArray(value)?value.map(redact):value&&typeof value==='object'
        ?Object.fromEntries(Object.entries(value).map(([key,item])=>[redact(key),/(hash|sha256|sha512|fingerprint|digest)|^sha$/i.test(key)?'[omitted]':redact(item)]))
        :typeof value==='string'?value.replace(/\b[a-f0-9]{40,64}\b/gi,'[omitted]'):value;
    try{return JSON.stringify(redact(JSON.parse(raw)));}catch{return raw.replace(/\b[a-f0-9]{40,64}\b/gi,'[omitted]');}
}
export const artifactJson = (value: unknown) => JSON.stringify(withoutHashes(value), null, 2) + '\n';
