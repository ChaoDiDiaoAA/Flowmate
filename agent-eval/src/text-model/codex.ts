import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { scanEvidence } from '../execution/evidence-safety.ts';

export const nativeTextModelConfigSchema = z.object({ provider: z.literal('codex-cli'), executable: z.string().trim().min(1),
    model: z.string().trim().min(1), reasoningEffort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    timeoutMs: z.number().int().positive().max(300000) }).strict();
export type NativeTextModelConfig = z.infer<typeof nativeTextModelConfigSchema>;
type ProcessOptions = { cwd: string; stdin: string; signal: AbortSignal };
export type ProcessRunner = (executable: string, args: string[], options: ProcessOptions) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Resolve only after close confirms that cancellation has terminated the child. */
export const runProcess: ProcessRunner = async (executable, args, options) => {
    options.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            !/^(OPENAI_API_KEY|OPENAI_BASE_URL|OPENAI_ORG_ID|OPENAI_PROJECT_ID|CODEX_API_KEY)$/i.test(key)));
        const child = spawn(executable, args, { cwd: options.cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', failure: Error | undefined, termination: ReturnType<typeof setTimeout> | undefined;
        const abort = () => {
            failure = options.signal.reason instanceof Error ? options.signal.reason : Error('Native model cancelled');
            child.kill('SIGKILL');
            termination = setTimeout(() => reject(Object.assign(Error('Native model process termination unconfirmed'), { stopConfirmed: false })), 2000);
        };
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => { failure = error; });
        child.stdin.on('error', error => { failure ??= error; });
        child.once('close', code => {
            clearTimeout(termination); options.signal.removeEventListener('abort', abort);
            if (failure) reject(failure); else resolve({ code, stdout, stderr });
        });
        options.signal.addEventListener('abort', abort, { once: true });
        if (options.signal.aborted) abort();
        child.stdin.end(options.stdin);
    });
};

export const nativeUsageSchema = z.object({ input_tokens: z.number().int().nonnegative().optional(), cached_input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional() }).passthrough()
    .refine(usage => usage.input_tokens !== undefined || usage.cached_input_tokens !== undefined || usage.output_tokens !== undefined);
export function parseCodexJSONL(stdout: string) {
    let text: string | null = null, complete = false, usage: z.infer<typeof nativeUsageSchema> | null = null, responseModel: string | null = null;
    for (const line of stdout.split(/\r?\n/).filter(line => line.trim())) {
        if (complete) throw Error('Native model returned events after its completed turn');
        const event = z.object({ type: z.string() }).passthrough().parse(JSON.parse(line));
        if (event.type === 'turn.failed' || event.type === 'error') throw Error('Native model turn failed');
        if (event.type === 'item.completed') {
            const item = z.object({ type: z.string() }).passthrough().parse(event.item);
            if (item.type === 'agent_message') {
                if (text !== null || complete) throw Error('Native model returned multiple final messages');
                text = z.string().parse(item.text);
                if (typeof item.model === 'string') responseModel = item.model;
            } else if (!['reasoning'].includes(item.type)) throw Error('Native text model attempted a tool or unsupported item');
        }
        if (event.type === 'turn.completed') {
            if (complete || text === null) throw Error('Native model completion lacks a unique final message');
            complete = true;
            const parsed = nativeUsageSchema.safeParse(event.usage); usage = parsed.success ? parsed.data : null;
            if (typeof event.model === 'string') responseModel = event.model;
        }
    }
    if (!complete || text === null) throw Error('Native model response incomplete');
    return { text, usage, responseModel };
}
type NativeTextResponse = ReturnType<typeof parseCodexJSONL> & { usageSource: 'codex-cli' | 'unknown'; cliVersion: string; cost: null; internalRetries: null };
export class NativeJSONError extends Error {
    constructor(readonly response: NativeTextResponse) { super('Native model final message is not JSON'); }
}

export async function generateJSON(config: NativeTextModelConfig,
    input: { system: string; data: string; schema: Record<string, unknown>; signal?: AbortSignal },
    dependencies: { runner?: ProcessRunner } = {}) {
    config = nativeTextModelConfigSchema.parse(config);
    input.signal?.throwIfAborted();
    const signal = AbortSignal.any([AbortSignal.timeout(config.timeoutMs), ...(input.signal ? [input.signal] : [])]);
    const directory = await mkdtemp(join(tmpdir(), 'flowmate-text-model-'));
    const runner = dependencies.runner ?? runProcess;
    let terminated = true, cliVersion: string | null = null;
    try {
        const schemaPath = join(directory, 'output-schema.json'), instructionsPath = join(directory, 'instructions.md');
        await writeFile(schemaPath, JSON.stringify(input.schema)); await writeFile(instructionsPath, input.system);
        const version = await runner(config.executable, ['--version'], { cwd: directory, stdin: '', signal });
        if (version.code !== 0) throw Error('Native Codex version probe failed');
        cliVersion = version.stdout.trim();
        if (!cliVersion) throw Error('Native Codex version unavailable');
        const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
            '--json', '--color', 'never', '--model', config.model, '--output-schema', schemaPath,
            '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'features.multi_agent=false',
            '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0', '-c', 'mcp_servers={}',
            '-c', 'model_reasoning_effort=' + JSON.stringify(config.reasoningEffort), '-c', 'model_instructions_file=' + JSON.stringify(instructionsPath), '-'];
        const result = await runner(config.executable, args, { cwd: directory, stdin: input.data, signal });
        if (result.code !== 0) {
            const diagnostic = scanEvidence(result.stderr).value.trim().slice(0, 6000);
            throw Error('Native model exit ' + result.code + (diagnostic ? ': ' + diagnostic : ''));
        }
        const parsed = parseCodexJSONL(result.stdout);
        const response: NativeTextResponse = { ...parsed, usageSource: parsed.usage ? 'codex-cli' : 'unknown', cliVersion, cost: null, internalRetries: null };
        let value: unknown;
        try { value = JSON.parse(parsed.text); } catch { throw new NativeJSONError(response); }
        return { ...response, value };
    } catch (error) {
        if (error instanceof Error && 'stopConfirmed' in error && error.stopConfirmed === false) terminated = false;
        throw error instanceof Error ? Object.assign(error, { cliVersion, stopConfirmed: terminated }) : error;
    } finally {
        if (terminated) await rm(directory, { recursive: true, force: true });
    }
}
