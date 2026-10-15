import { syntheticNativeModel } from '../support/native-model.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHttpProvider, mkdtempSync } from '../../../tests/support/resources.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import { ResourceManifestSchema } from '../../../packages/contracts/src/resources.ts';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import type { AgentTrialSession } from '../../src/adapters/agent.ts';

test('selected declared resource reaches the actual local Host without adjacent quality files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'eval-declared-resource-'));
    const declared = join(root, 'declared'), pkg = join(declared, 'eval-declared-only'); mkdirSync(pkg, { recursive: true });
    const body = '---\nname: eval-declared-only\ndescription: Controlled independent resource fixture.\ndisable-model-invocation: false\n---\n# Controlled resource\nUse only current authorized observations.\n';
    const manifest = ResourceManifestSchema.parse({ schemaVersion: 2, kind: 'skill', id: 'eval-declared-only', version: 'v1', bodyFile: 'SKILL.md', keywords: ['controlled'], requires: [],
        files: [{ path: 'SKILL.md', bytes: Buffer.byteLength(body) }] });
    writeFileSync(join(pkg, 'resource.json'), JSON.stringify(manifest)); writeFileSync(join(pkg, 'SKILL.md'), body);
    writeFileSync(join(pkg, 'gold.json'), 'FORBIDDEN_ADJACENT_GOLD'); writeFileSync(join(declared, 'future-input.json'), 'FORBIDDEN_FUTURE_INPUT');
    const ref = { kind: 'skill' as const, id: manifest.id, version: manifest.version };
    const requests: string[] = [];
    const server = await createHttpProvider(async request => {
        requests.push(await request.text());
        const chunk = (delta: object, finish: string | null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
        return new Response(chunk({ role: 'assistant', content: 'Controlled answer.' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }, '0.0.0.0');
    const directory = join(root, 'trial'); mkdirSync(directory); let session: AgentTrialSession | undefined;
    try {
        session = await prepareHostTrial({ identity: { executionId: 'synthetic-declared', trialId: 'one', caseId: 'synthetic', caseVersion: 1 }, directory,
            input: { prompt: 'Answer the controlled request.', materials: [] }, requires: ['agent'], resourceRoot: declared,
            configuration: { modelCapabilities: syntheticNativeModel, model: 'fixture', api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.port}/v1`, resources: { prompt: null, enabledSkills: [ref] } } },
            new AbortController().signal, { repo: REPO_ROOT, credential: 'synthetic-resource-key' });
        const result = await session.execute(AbortSignal.timeout(30000));
        expect(result.status).toBe('completed'); expect(requests).toHaveLength(1); expect(requests[0]).toContain('eval-declared-only');
        expect(requests[0]).not.toContain('FORBIDDEN_'); expect(requests[0]).not.toContain('synthetic-resource-key');
        const environment = result.evidence.environment!.actual as { isolation: { files: string[]; filesystemSandbox: boolean } };
        expect(environment.isolation.files.filter(file => file.includes('eval-declared-only')).sort()).toEqual(['resources/skills/eval-declared-only/SKILL.md', 'resources/skills/eval-declared-only/resource.json']);
        expect(environment.isolation.filesystemSandbox).toBe(false);
    } finally { if (session) expect((await session.close()).present).toBe(true); server.stop(true); }
}, 90000);
