import { expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main } from '../../src/cli.ts';
import { dataset, fixtureDirectory, fixtureRepo } from '../support/fixtures.ts';

async function withConfiguration(action: () => Promise<void>) {
    const exit = process.exitCode;
    const values = { FLOWMATE_EVAL_AGENT_MODEL: 'deepseek-v4-flash', FLOWMATE_EVAL_AGENT_API: 'openai-completions',
        FLOWMATE_EVAL_AGENT_BASE_URL: 'https://unused.invalid/v1', FLOWMATE_EVAL_AGENT_API_KEY: 'synthetic-cli-eval-key',
        FLOWMATE_JUDGE_API: '', FLOWMATE_JUDGE_PROVIDER: '', FLOWMATE_JUDGE_BASE_URL: '', FLOWMATE_JUDGE_MODEL: '', FLOWMATE_JUDGE_API_KEY: '' };
    const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    try { await action(); }
    finally { process.exitCode=exit??0; for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test('doctor reports actual native Agent capacities without generating or changing product settings', async () => {
    await withConfiguration(async () => {
        Object.assign(process.env, { FLOWMATE_JUDGE_PROVIDER: 'openai-compatible', FLOWMATE_JUDGE_MODEL: 'llama-3.3-70b-versatile',
            FLOWMATE_JUDGE_BASE_URL: 'https://judge.invalid/v1/synthetic-doctor-judge-key', FLOWMATE_JUDGE_API_KEY: 'synthetic-doctor-judge-key' });
        const settings = join(fixtureRepo, 'data/settings.json'), original = '{"desktop":"must remain unchanged"}\n';
        writeFileSync(settings, original);
        let requests = 0;
        const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { requests++; throw Error('no network in preparation'); }, { preconnect: () => {} }));
        const logs = spyOn(console, 'log').mockImplementation(() => {});
        try {
            await main(['doctor', '--backend', 'local'], fixtureRepo);
            const result = JSON.parse(String(logs.mock.calls.at(-1)![0]));
            expect(result.agent.configuration).toMatchObject({ model: 'deepseek-v4-flash', api: 'openai-completions',
                modelCapabilities: { contextWindow: 1000000, maxTokens: 384000, source: 'pi-sdk-model-catalog' } });
            expect(requests).toBe(0);
            expect(JSON.stringify(result)).not.toContain('synthetic-cli-eval-key');
            expect(JSON.stringify(result)).not.toContain('synthetic-doctor-judge-key');
            expect(readFileSync(settings, 'utf8')).toBe(original);
        } finally { network.mockRestore(); logs.mockRestore(); }
    });
}, 20000);

test('doctor rejects an unknown Anthropic Judge before generating text or querying a provider', async () => {
    await withConfiguration(async()=>{
        Object.assign(process.env,{FLOWMATE_JUDGE_PROVIDER:'anthropic',FLOWMATE_JUDGE_MODEL:'missing-judge',
            FLOWMATE_JUDGE_BASE_URL:'https://judge.invalid/v1',FLOWMATE_JUDGE_API_KEY:'fake-metadata-judge-key'});
        let reads=0;
        const network=spyOn(globalThis,'fetch').mockImplementation(Object.assign(async(_url:unknown,init?:RequestInit)=>{
            expect(init!.method).toBe('GET');expect(init!.body).toBeUndefined();reads++;return new Response('{}',{status:404});
        },{preconnect:()=>{}}));
        const logs=spyOn(console,'log').mockImplementation(()=>{});
        try {
            await main(['doctor','--backend','local'],fixtureRepo);
            const result=JSON.parse(String(logs.mock.calls.at(-1)![0]));
            expect(reads).toBe(0);expect(result.ok).toBe(false);expect(process.exitCode).toBe(1);
            expect(result.issues.some((s:string)=>s.includes('absent from the Pi SDK catalog'))).toBe(true);
        } finally {network.mockRestore();logs.mockRestore();}
    });
},20000);

test('an unknown CLI model override fails before execution records, Judge or platform requests', async () => {
    await withConfiguration(async () => {
        let requests = 0;
        const network = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async () => { requests++; throw Error('no network'); }, { preconnect: () => {} }));
        try {
            await expect(main(['run', '--dataset', dataset.manifest.id, '--model', 'unregistered-evaluation-alias',
                '--execution-id', 'unknown-native-model', '--judge', 'off'], fixtureRepo)).rejects.toThrow('absent from the Pi SDK catalog');
            expect(requests).toBe(0);
            expect(existsSync(join(fixtureRepo, 'agent-eval/runs/business/unknown-native-model'))).toBe(false);
        } finally { network.mockRestore(); }
    });
}, 20000);

test('data validation ignores missing Agent and Judge credentials', async () => {
    await withConfiguration(async () => {
        process.env.FLOWMATE_EVAL_AGENT_API_KEY = '';
        process.env.FLOWMATE_EVAL_AGENT_MODEL = '';
        const logs = spyOn(console, 'log').mockImplementation(() => {});
        try { await main(['dataset', 'validate', '--dir', fixtureDirectory], fixtureRepo); expect(JSON.parse(String(logs.mock.calls.at(-1)![0])).valid).toBe(true); }
        finally { logs.mockRestore(); }
    });
});

test('a fresh CLI process never echoes a file-only key in an invalid API override error', () => {
    const key = 'synthetic-file-only-cli-key', source = resolve(import.meta.dir, '../../src/cli.ts');
    const entry = join(fixtureRepo, 'agent-eval/src/cli.ts');
    const copied = readFileSync(source, 'utf8').replace(/from '(\.[^']+)'/g, (_, specifier) => "from '" + new URL(specifier, pathToFileURL(source)).href + "'");
    writeFileSync(entry, copied);
    mkdirSync(join(fixtureRepo, 'agent-eval/configs'), { recursive: true });
    writeFileSync(join(fixtureRepo, 'agent-eval/configs/.env'), 'FLOWMATE_EVAL_AGENT_API_KEY=' + key + '\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^FLOWMATE_(EVAL_AGENT_|LLM_|JUDGE_)|^LANGFUSE_/.test(name)));
    const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
    for (const invalid of [['--api', key], ['--' + key]]) {
        const result = spawnSync('node', ['--import', loader, entry, 'run', '--dataset', dataset.manifest.id, ...invalid,
            '--execution-id', 'file-only-error', '--judge', 'off'], { cwd: fixtureRepo, env, encoding: 'utf8', windowsHide: true, timeout: 20000 });
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/api|argument/i);
        expect(result.stderr + result.stdout).not.toContain(key);
    }
    expect(existsSync(join(fixtureRepo, 'agent-eval/runs/business/file-only-error'))).toBe(false);
}, 25000);
