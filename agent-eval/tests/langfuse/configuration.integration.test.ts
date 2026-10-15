import { saveReport, readReport } from '../../src/reports/store.ts';
import { main } from '../../src/cli.ts';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportReport } from '../../src/langfuse/export.ts';
import { reportFixture } from '../support/fixtures.ts';

test('Langfuse env reaches the real SDK against a local stub and resends without changing scores', async () => {
    const root=mkdtempSync(join(tmpdir(),'eval-lf-config-')), requests:Array<{url:string;auth:string|null;ids:string[]}>=[];
    let partial=true;
    const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
        const body=await request.json() as {batch:Array<{id:string}>};
        requests.push({url:request.url,auth:request.headers.get('authorization'),ids:body.batch.map(event=>event.id)});
        return Response.json({successes:body.batch.filter((_,i)=>!partial||i===0).map(event=>({id:event.id,status:201})),
            errors:partial?body.batch.slice(1).map(event=>({id:event.id,status:500,message:'synthetic partial'})):[]});
    }});
    const oldPublic=process.env.LANGFUSE_PUBLIC_KEY,oldSecret=process.env.LANGFUSE_SECRET_KEY;
    try {
        process.env.LANGFUSE_PUBLIC_KEY='test-lf-public';process.env.LANGFUSE_SECRET_KEY='test-lf-secret';
        mkdirSync(join(root,'agent-eval/configs'),{recursive:true});
        writeFileSync(join(root,'agent-eval/configs/.env'),`# 本地模拟平台\nLANGFUSE_BASE_URL=http://127.0.0.1:${server.port}\n`);
        const report=reportFixture(),scores=JSON.stringify(report.trials),file=join(root,'agent-eval/runs',report.executionId,'report.json');
        saveReport(file,report);
        await exportReport(report,file,undefined,root);expect(report.export,JSON.stringify(report.export)).toMatchObject({status:'partial'});
        partial=false;await main(['resend','--execution-id',report.executionId],root);expect(readReport(file).export.status).toBe('complete');
        expect(JSON.stringify(report.trials)).toBe(scores);expect(requests).toHaveLength(2);
        expect(requests[0]!.auth).toBe('Basic '+Buffer.from('test-lf-public:test-lf-secret').toString('base64'));
        expect(requests[1]!.ids).toEqual(requests[0]!.ids.slice(1));
        expect(report.export.url).toBe(`http://127.0.0.1:${server.port}`);
        expect(JSON.stringify(report)).not.toContain('test-lf-secret');
    } finally {
        if(oldPublic===undefined)delete process.env.LANGFUSE_PUBLIC_KEY;else process.env.LANGFUSE_PUBLIC_KEY=oldPublic;
        if(oldSecret===undefined)delete process.env.LANGFUSE_SECRET_KEY;else process.env.LANGFUSE_SECRET_KEY=oldSecret;
        await server.stop(true);rmSync(root,{recursive:true,force:true});
    }
});
