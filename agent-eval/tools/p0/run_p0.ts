/** P0-only command orchestration. Product execution is explicit; importing is inert. */
import { spawn, execFile } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { assertNoLinkedAncestors } from '../../../packages/core/src/storage/file-store.ts';
import { readCases, writeNewJson } from '../../src/runner/p0-binding.ts';

export interface P0Command {
  name: string; exe: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv;
  stdoutPath: string; stderrPath: string; signal: AbortSignal;
}
type Options = {
  projectRoot: string; executionId?: string; signal?: AbortSignal;
  execute?: (command: P0Command) => Promise<number>;
  log?: (line: string) => void;
};
type Step = { command: string[]; startedAt: string; endedAt: string; exitCode: number; error?: string };
type Review = { status: string; cases?: Array<{id:string;status:string;observations?:Array<{status:string;reason:string}>}>; blockers?:string[]; problems?:string[] };
const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const exists = async (path: string) => { try { await access(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } };

/** Captures bounded-memory output to files and owns only the child tree it starts. */
export async function executeCommand(c: P0Command): Promise<number> {
  c.signal.throwIfAborted();
  const out = openSync(c.stdoutPath, 'wx');
  let err: number | undefined;
  try {
    err = openSync(c.stderrPath, 'wx');
    return await new Promise<number>((done, reject) => {
      const child = spawn(c.exe, c.args, { cwd:c.cwd, env:c.env, windowsHide:true,
        detached:process.platform !== 'win32', stdio:['ignore',out,err!] });
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopping: Promise<void> | undefined;
      const abort = () => {
        if (stopping) return;
        stopping = new Promise<void>(resolveStop => {
          if (!child.pid) { resolveStop(); return; }
          if (process.platform === 'win32') {
            // Windows signals do not reliably propagate to descendants (Vitest/Bun/Python).
            execFile('taskkill.exe', ['/PID',String(child.pid),'/T','/F'], {windowsHide:true,timeout:5_000}, () => resolveStop());
          } else {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* close/timeout records the outcome */ }
            resolveStop();
          }
        });
        timer = setTimeout(() => {
          child.unref(); c.signal.removeEventListener('abort',abort);
          reject(new Error('中断后未确认子进程停止；保留实例和锁，检查进程后再执行。'));
        }, 10_000);
      };
      const finish = () => { if(timer)clearTimeout(timer);c.signal.removeEventListener('abort',abort); };
      child.once('error', e => { finish();reject(e); });
      child.once('close', async (code,signal) => { await stopping;finish();done(c.signal.aborted ? 130 : code ?? (signal ? 2 : 0)); });
      c.signal.addEventListener('abort',abort,{once:true});
      if(c.signal.aborted)abort();
    });
  } finally { closeSync(out);if(err !== undefined)closeSync(err); }
}

export async function runP0(options: Options): Promise<{exitCode:number;runRoot:string;instanceRoot:string}> {
  const project = resolve(options.projectRoot);
  const id = options.executionId ?? `p0-${new Date().toISOString().replace(/[-:.]/g,'')}-${randomUUID().slice(0,8)}`;
  const runRoot=join(project,'agent-eval','runs',id), instanceRoot=join(project,'FlowmateData','p0-evals',id);
  const log=options.log ?? console.log, signal=options.signal ?? new AbortController().signal;
  const execute=options.execute ?? executeCommand;
  const sourceRoot=join(project,'data','invoices','voxel51');
  const env={...process.env,FLOWMATE_SOURCE_ROOT:sourceRoot};
  const steps: Record<string,Step>={};
  let ownsOutput=false, exitCode=2, review:Review|undefined, issue='';
  let active='准备';
  const checkAbort=()=>{if(signal.aborted)throw new Error('用户中断');};
  async function step(name:string,label:string,exe:string,args:string[],required=true) {
    checkAbort();active=name;log(`→ ${label}`);
    const startedAt=new Date().toISOString();let code=2,error:string|undefined;
    try {code=await execute({name,exe,args,cwd:project,env,stdoutPath:join(runRoot,`${name}.stdout.log`),stderrPath:join(runRoot,`${name}.stderr.log`),signal});}
    catch(e){error=String(e);}
    steps[name]={command:[exe,...args],startedAt,endedAt:new Date().toISOString(),exitCode:code,...(error?{error}:{})};
    await writeNewJson(join(runRoot,`${name}.step.json`),steps[name]);
    checkAbort();
    if(code!==0)log(`  ${label}未成功，详细日志：${join(runRoot,`${name}.stderr.log`)}`);
    if(error || (required && code!==0))throw new Error(`${label}未完成${error?`：${error}`:`（退出码 ${code}）`}；依赖步骤已停止。`);
    return code;
  }
  const bun=(name:string,label:string,args:string[],required=true)=>step(name,label,process.execPath,args,required);
  const product=(name:string,label:string,args:string[]=[])=>bun(name,label,['run','scripts/p0.ts',name,'--instance-root',instanceRoot,...args]);
  try {
    if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error('无效的运行标识');
    checkAbort();
    await assertNoLinkedAncestors(runRoot);await assertNoLinkedAncestors(instanceRoot);
    if(await exists(runRoot)||await exists(instanceRoot))throw new Error('运行目录或产品实例已存在；拒绝覆盖，请使用新运行。');
    await mkdir(dirname(runRoot),{recursive:true});await mkdir(runRoot);ownsOutput=true;
    log('P0 基础功能检查：不调用模型，不使用 Inspect AI。');log(`结果目录：${runRoot}`);
    const cases=await readCases(join(project,'agent-eval/stage-evals/P0/cases.json'));
    const manifestHash=await sha(join(sourceRoot,'manifest.json'));
    await bun('bun-version','检查 Bun',['--version']);
    await step('node-version','检查 Node','node',['--version']);
    const bunParts=(await readFile(join(runRoot,'bun-version.stdout.log'),'utf8')).trim().replace(/^v/,'').split('.').map(Number);
    const nodeMajor=Number((await readFile(join(runRoot,'node-version.stdout.log'),'utf8')).trim().replace(/^v/,'').split('.')[0]);
    if(!(bunParts[0]>1 || bunParts[0]===1 && bunParts[1]>=4) || !(nodeMajor>=24))throw new Error('需要 Bun ≥1.4、Node ≥24；请检查当前环境。');
    await step('python-environment','检查 Python / Pillow / pytest','python',['-B','-c','import sys,PIL,pytest; print(sys.version); print(PIL.__version__); print(pytest.__version__)']);
    await step('git-version','检查 Git','git',['--version']);
    await product('init','初始化独立测试实例');
    const verifyArgs=['--instance-root',instanceRoot,'--output-root',runRoot,'--source-manifest-sha256',manifestHash,'--purpose','development'];
    await bun('freeze','固定本次版本与判据',['run','scripts/p0-verify-published.ts',...verifyArgs,'--freeze','true','--case-set',join(project,'agent-eval/stage-evals/P0/cases.json')]);
    const expected=join(runRoot,'expected-binding.json'),frozen=join(runRoot,'cases.frozen.json');
    const bindingHash=await sha(expected);
    await bun('typecheck','类型检查',['run','typecheck']);
    await bun('tests','产品功能测试',['run','test:p0','--reporter=json',`--outputFile=${join(runRoot,'vitest-product.json')}`],false);
    await bun('facility','评测设施自检',['x','--no-install','vitest','run','tests/facility/p0-binding.test.ts','tests/facility/p0-command.test.ts','tests/product/evidence-contract.test.ts','--config','vitest.config.ts','--reporter=json',`--outputFile=${join(runRoot,'vitest-facility.json')}`],false);
    await step('source-audit','全量来源核验','python',['-B','agent-eval/tools/p0/p0_source_audit.py','--project',project,'--output',join(runRoot,'source-closure-audit.json')]);
    const audit=await json(join(runRoot,'source-closure-audit.json'));
    if(audit.status!=='PASS_STRUCTURAL_ONLY'||audit.errorCount!==0)throw new Error('来源核验未通过；已停止发布，请查看 source-closure-audit.json。');
    const inputArgs=['--manifest-sha256',manifestHash,'--purpose','development'];
    await product('inspect','检查产品输入',inputArgs);
    const inspection=await json(join(runRoot,'inspect.stdout.log'));
    if(!Array.isArray(inspection.issues)||inspection.issues.length)throw new Error('产品输入检查不完整或存在问题；停止发布。');
    await product('publish','发布至本次测试实例',[...inputArgs,'--request-id',randomUUID()]);
    const publication=await json(join(runRoot,'publish.stdout.log'));
    if(!publication.manifest||!publication.documentRefs?.length)throw new Error('缺少有效发布回执，停止依赖步骤。');
    const publicationPath=join(instanceRoot,'publication.json'),documentPath=join(instanceRoot,'document-ref.json'),manifestPath=join(instanceRoot,'manifest-ref.json');
    await writeNewJson(publicationPath,publication);await writeNewJson(documentPath,publication.documentRefs[0]);await writeNewJson(manifestPath,publication.manifest);
    const readArgs=['--document-ref',documentPath,'--manifest-ref',manifestPath,'--purpose','development'];
    await product('read','读取已发布输入',readArgs);await product('capture','保存输入投影',readArgs);
    const captured=await json(join(runRoot,'capture.stdout.log'));
    if(!captured.projection)throw new Error('缺少输入投影回执');
    const projectionPath=join(instanceRoot,'projection-ref.json');await writeNewJson(projectionPath,captured.projection);
    await product('read-captured','跨进程重读',['--projection-ref',projectionPath,'--purpose','development']);
    await bun('fault','故障恢复检查',['run','scripts/p0-fault-probe.ts','--output-root',runRoot],false);
    const outputs:Record<string,string>={};
    for(const name of ['vitest-product.json','vitest-facility.json','source-closure-audit.json','fault-summary.json'])if(await exists(join(runRoot,name)))outputs[name]=await sha(join(runRoot,name));
    await writeNewJson(join(runRoot,'execution-steps.json'),{expectedBindingSha256:bindingHash,steps,outputs});
    await bun('verify','全量重读与证据验证',['run','scripts/p0-verify-published.ts',...verifyArgs,'--publication-ref',publicationPath,'--case-set',frozen]);
    const reviewCode=await step('review','逐 Case 复核','python',['-B','agent-eval/tools/p0/review_p0_report.py','--report',join(runRoot,'p0-f-evidence-v1.json'),'--evidence-root',runRoot,'--expected-binding',expected,'--frozen-checks',frozen,'--output',join(runRoot,'stage-review.json')],false);
    review=await json(join(runRoot,'stage-review.json')) as Review;
    if(!['PASS','FAIL','UNJUDGEABLE','ERROR','NOT_RUN','BLOCKED'].includes(review.status))throw new Error('复核报告状态无效');
    exitCode=review.status==='PASS'?0:review.status==='FAIL'?1:2;
    if(reviewCode!==exitCode)throw new Error('复核退出码与报告不一致，不能采用通过结论');
    if(exitCode===0 && (Object.values(steps).some(s=>s.exitCode!==0) || review.cases?.length!==cases.value.cases.length || review.cases.some(c=>c.status!=='PASS')))throw new Error('复核 PASS 与步骤或 Case 完整性不一致，须排查设施。');
    checkAbort();
  } catch(e) {exitCode=signal.aborted?130:2;issue=`${active}：${e instanceof Error?e.message:String(e)}`;}
  const title=exitCode===0?'通过':exitCode===1?'未通过':exitCode===130?'未完成（用户中断）':'未完成／无法判定';
  const details=(review?.cases??[]).filter(c=>c.status!=='PASS').map(c=>`- ${c.id}：${c.status}；${(c.observations??[]).filter(o=>o.status!=='PASS').map(o=>o.reason).join('；')}`);
  const next=exitCode===0?'查看 stage-review.json：仅本地基础功能及资产技术检查通过，不代表数据许可、业务语义、真实 Agent 或生产用途通过。':'查看失败步骤日志与下列原因，处理后重新执行 bun run p0:eval；不要改写旧证据。';
  const summary=[`# P0：${title}`,'',issue,...details,...(review?.blockers??[]).map(x=>`- 阻断：${x}`),...(review?.problems??[]).map(x=>`- 设施问题：${x}`),'',next,`正式复核：${review?'stage-review.json（原始判定保留）':'尚未生成完整复核结果'}`,`产品测试实例：${instanceRoot}`,'评测目录保存日志和报告，产品实例保存数据库及文件；它们不是两套评测结果。',...(exitCode===130?['中断不证明资源已正常关闭；保留实例和锁，确认本次子进程及句柄释放后再处理。']:[]),'本命令不自动删除实例或报告。'].filter(Boolean).join('\n');
  if(ownsOutput){try{await writeFile(join(runRoot,'summary.md'),summary+'\n',{flag:'wx'});}catch(e){log(`摘要保存失败：${String(e)}`);if(exitCode!==130)exitCode=2;}}
  log(`P0：${title}`);if(issue)log(issue);for(const detail of details)log(detail);
  for(const problem of [...review?.blockers??[],...review?.problems??[]])log(problem);
  log(next);if(ownsOutput)log(`结果：${join(runRoot,'summary.md')}`);
  return {exitCode,runRoot,instanceRoot};
}

if (import.meta.main) {
  if(process.argv.length>2){console.error('用法：bun run p0:eval（无需参数）');process.exitCode=2;}
  else {
    const controller=new AbortController();const stop=()=>controller.abort();
    process.on('SIGINT',stop);process.on('SIGTERM',stop);
    try { const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');process.exitCode=(await runP0({projectRoot,signal:controller.signal})).exitCode; }
    finally {process.off('SIGINT',stop);process.off('SIGTERM',stop);}
  }
}
