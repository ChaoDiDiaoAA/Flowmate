import { expect, test } from 'bun:test';
import { main } from '../../src/cli.ts';
import { fixtureRepo } from '../support/fixtures.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('all batch rejects a single case or Execution ID before preparation', async () => {
    for(const args of [['--case','FM-001'],['--execution-id','ambiguous']])
        await expect(main(['run','--dataset','all',...args],fixtureRepo)).rejects.toThrow('cannot use --case or --execution-id');
});
test('saved-result upload requires exactly one explicit target', async () => {
    for(const args of [[],['--execution-id','one','--report',resolve('one.json')]])
        await expect(main(['resend',...args],fixtureRepo)).rejects.toThrow('Exactly one');
});
test('public shortcuts require a local judged batch; upload has no run action', () => {
    const scripts=JSON.parse(readFileSync(resolve(import.meta.dir,'../../../package.json'),'utf8')).scripts;
    for(const selection of ['smoke','full']) {
        expect(scripts['eval:'+selection]).toContain('run --dataset all --selection '+selection);
        expect(scripts['eval:'+selection]).toContain('--judge required --backend local');
    }
    expect(scripts['eval:upload']).toEndWith('resend');
});
