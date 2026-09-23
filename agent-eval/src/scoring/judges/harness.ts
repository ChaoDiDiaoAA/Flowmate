import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { scanEvidence } from '../../execution/evidence-safety.ts';
import { requestJudge, publicJudgeConfig, type JudgeConfig, type Fetcher } from './client.ts';
export function parseJudgment(text: string) { return z.object({ score: z.number().min(0).max(1), reason: z.string().trim().min(1) }).strict().parse(JSON.parse(text)); }
export async function runJudge(config: JudgeConfig, system: string, data: string, fetcher?: Fetcher) {
    const record = { callId: randomUUID(), configuration: publicJudgeConfig(config), startedAt: new Date().toISOString(), endedAt: '', attempts: 1, usage: null as unknown, responseModel: null as unknown, raw: null as string | null, error: null as string | null, judgment: null as ReturnType<typeof parseJudgment> | null };
    try {
        const result = await requestJudge(config, system, data, fetcher);
        record.raw = result.text;
        record.usage = result.usage;
        record.responseModel = result.responseModel;
        record.judgment = parseJudgment(result.text);
    }
    catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
    }
    record.endedAt = new Date().toISOString();
    const scanned = scanEvidence(record, [config.apiKey, ...[process.env.FLOWMATE_LLM_API_KEY, process.env.LANGFUSE_SECRET_KEY].filter((s): s is string => !!s)]);
    if (scanned.fact.actual && (scanned.fact.actual as {
        leaked: boolean;
    }).leaked) {
        scanned.value.error = 'Judge response contained configured secret; redacted';
        scanned.value.judgment = null;
    }
    return scanned.value;
}
