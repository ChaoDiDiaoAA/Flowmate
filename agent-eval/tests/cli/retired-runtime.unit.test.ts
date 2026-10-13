import { expect, test } from 'bun:test';
import { HELP, main } from '../../src/cli.ts';
import { runConfigSchema } from '../../src/execution/runner.ts';

test('standalone Runtime recovery and strategy configuration are no longer evaluation entry points',async()=>{
 expect(HELP).not.toContain('runtime snapshot');
 expect(runConfigSchema.safeParse({runtime:{version:1,group:'A',phase:'development'}}).success).toBe(false);
 await expect(main(['runtime','snapshot'])).rejects.toThrow('Flowmate local evaluation');
});
