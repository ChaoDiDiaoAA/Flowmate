import type { EvidenceFact } from '../types.ts';
/** Keep the scan outcome as evidence, but never write the detected secret itself. */
export function scanEvidence<T>(value: T, secrets: string[] = [
    process.env.FLOWMATE_JUDGE_API_KEY, process.env.FLOWMATE_LLM_API_KEY, process.env.LANGFUSE_SECRET_KEY,
    process.env.LANGFUSE_PUBLIC_KEY, 'fixture-synthetic-key',
].filter((item): item is string => Boolean(item))): {
    value: T;
    fact: EvidenceFact;
} {
    let leaked = false;
    const redact = (text: string): string => {
        let safe = text;
        for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
            if (safe.includes(secret)) {
                leaked = true;
                safe = safe.split(secret).join('[REDACTED]');
            }
        }
        return safe.replace(/sk-lf-[A-Za-z0-9-]+/g, () => { leaked = true; return '[REDACTED]'; });
    };
    const visit = (item: unknown): unknown => {
        if (typeof item === 'string')
            return redact(item);
        if (Array.isArray(item))
            return item.map(visit);
        if (item && typeof item === 'object')
            return Object.fromEntries(Object.entries(item).map(([key, child]) => [redact(key), visit(child)]));
        return item;
    };
    const safe = visit(value) as T;
    return { value: safe, fact: { present: true, actual: { leaked }, source: 'evaluation:redaction-scan' } };
}
