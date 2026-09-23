import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentKernel, AgentTrial, AgentTrialSession } from '../adapters/agent.ts';
import type { CaseExecutionResult } from '../types.ts';
import { scanEvidence } from './evidence-safety.ts';
import { hash } from '../datasets/local.ts';
import { z } from 'zod';
const inputSchema = z.object({ prompt: z.string(), materials: z.array(z.object({ sample: z.string(), file: z.string(), text: z.string() }).strict()) }).strict();
const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Lifecycle timeout')), ms); })]);
    }
    finally {
        clearTimeout(timer!);
    }
};
export async function executeCase(kernel: AgentKernel, trial: AgentTrial, timeoutMs: number, stopGraceMs: number, signal?: AbortSignal) {
    const expectedIdentity = structuredClone(trial.identity), original = structuredClone(trial.input);
    let projected = structuredClone(original);
    mkdirSync(trial.directory, { recursive: true });
    writeFileSync(join(trial.directory, 'owner.json'), JSON.stringify(trial.identity), { flag: 'wx' });
    let execution: CaseExecutionResult = { identity: trial.identity, started: false, status: 'not-started', endpointReached: false,
        input: trial.input, answer: null, artifacts: [], observations: [], evidence: {}, configuration: trial.configuration, usage: {}, startedAt: null, endedAt: null };
    let session: AgentTrialSession | undefined, stopFailed = false, timedOut = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted)
        controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        if (controller.signal.aborted)
            throw new Error('Cancelled before preparation');
        const preparing = kernel.prepare(trial, controller.signal);
        try {
            session = await bounded(preparing, stopGraceMs);
        }
        catch (error) {
            controller.abort();
            stopFailed = true;
            // A late preparation must still be closed; no subsequent Trial starts.
            void preparing.then(async (s) => { try {
                await bounded(s.cancel(), stopGraceMs);
            }
            finally {
                await bounded(s.close(), stopGraceMs);
            } }).catch(() => { });
            throw error;
        }
        projected = inputSchema.parse(session.input);
        if (projected.prompt !== original.prompt || (!trial.setup && !isDeepStrictEqual(projected, original)))
            throw new Error('Unapproved initial input mutation');
        if (projected.materials.some(m => !original.materials.some(o => o.sample === m.sample && o.file === m.file)))
            throw new Error('Unregistered material in prepared input');
        if ((scanEvidence(projected).fact.actual as {
            leaked: boolean;
        }).leaked)
            throw new Error('Secret in prepared input');
        writeFileSync(join(trial.directory, 'input.json'), JSON.stringify({ original, input: projected, hash: hash(projected), setup: trial.setup }, null, 2) + '\n', { flag: 'wx' });
        if (controller.signal.aborted)
            throw new Error('Cancelled before model execution');
        const cancelled = new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error(timedOut ? 'Task budget exhausted' : 'Cancelled')), { once: true });
            if (controller.signal.aborted)
                reject(new Error('Cancelled'));
        });
        timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        execution = structuredClone(await Promise.race([session.execute(controller.signal), cancelled]));
    }
    catch (error) {
        if (session)
            try {
                execution = structuredClone(await bounded(session.snapshot(), stopGraceMs));
            }
            catch {
                stopFailed = true;
            }
        execution.status = signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : execution.started ? 'error' : 'not-started';
        execution.endpointReached = false;
        execution.error = { code: timedOut ? 'task_timeout' : signal?.aborted ? 'cancelled' : 'execution_error', message: String(error), infrastructure: !timedOut && !signal?.aborted };
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (session) {
            try {
                let cancelError: unknown;
                if (controller.signal.aborted)
                    try {
                        await bounded(session.cancel(), stopGraceMs);
                    }
                    catch (error) {
                        cancelError = error;
                    }
                const cleanup = await bounded(session.close(), stopGraceMs);
                execution.evidence.cleanup = cleanup;
                const actual = cleanup.actual as {
                    closed?: boolean;
                    stopped?: boolean;
                } | null;
                if (!cleanup.present || actual?.closed !== true || actual.stopped !== true)
                    throw new Error('Cleanup not proven');
                if (cancelError)
                    throw cancelError;
            }
            catch (error) {
                stopFailed = true;
                execution.error = { code: 'cleanup_failed', message: String(error), infrastructure: true };
                execution.status = 'error';
            }
        }
    }
    if (!isDeepStrictEqual(execution.identity, expectedIdentity)) {
        execution.status = 'error';
        execution.endpointReached = false;
        stopFailed = true;
        execution.error = { code: 'identity_mismatch', message: 'Agent evidence belongs to another Trial', infrastructure: true };
    }
    execution.endedAt ??= new Date().toISOString();
    const scanned = scanEvidence(execution);
    execution = scanned.value;
    execution.evidence['redaction-scan'] = scanned.fact;
    writeFileSync(join(trial.directory, 'execution.json'), JSON.stringify(execution, null, 2) + '\n');
    return { execution, stopFailed, projected };
}
