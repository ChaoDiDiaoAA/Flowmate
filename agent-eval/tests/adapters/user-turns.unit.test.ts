import { expect, spyOn, test } from 'bun:test';
import { prepareHostTrial } from '../../src/adapters/host-research.ts';
import { HostClient } from '../../../apps/desktop/main/host-client.ts';
import { REPO_ROOT } from '../../src/dataset-loader/local.ts';
import type { AgentTrial } from '../../src/adapters/agent.ts';
import { observeUserTurns } from '../../src/adapters/user-turns.ts';

for (const problem of ['missing', 'duplicate', 'inline-copy'] as const) test('private user turns reject ' + problem + ' before Host creation', async () => {
    const trial: AgentTrial = { identity: { executionId: 'synthetic', trialId: 'turns', caseId: 'synthetic', caseVersion: 1 },
        directory: 'unused', input: { prompt: 'First request.', materials: [] }, requires: ['agent'], configuration: {},
        steps: [{ id: 'first', action: 'user-message', instruction: 'First request.' },
            problem === 'inline-copy' ? { id: 'later', action: 'user-message', instruction: 'Later request.' } : { id: 'later', action: 'user-message', turnId: 'later' }] };
    Reflect.set(trial, 'turns', problem === 'missing' ? [] : problem === 'duplicate' ? [
        { id: 'later', role: 'user', content: 'Later request.' }, { id: 'later', role: 'user', content: 'Another request.' }
    ] : [{ id: 'later', role: 'user', content: 'Later request.' }]);
    const start = spyOn(HostClient.prototype, 'start');
    try {
        await expect(prepareHostTrial(trial, new AbortController().signal, { repo: REPO_ROOT, credential: 'fake' })).rejects.toThrow(/user turn|turn reference|turnId/i);
        expect(start).toHaveBeenCalledTimes(0);
    } finally { start.mockRestore(); }
});
test('a submitted turn with a missing receipt remains submitted rather than rejected or consumed',()=>{
    const turns=[{id:'later',role:'user' as const,content:'Later request.'}];
    expect(observeUserTurns(turns,[{turnId:'later',result:{pending:true}}],[])).toMatchObject([
        {turnId:'later',status:'submitted',submitted:true,accepted:false,consumed:false}
    ]);
});
