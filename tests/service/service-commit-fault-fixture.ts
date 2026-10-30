import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { ServiceInstallationSchema } from '../../packages/shared/src/service-layout.ts';

export type CommitFaultMode = 'native-input' | 'phase-link' | 'child-terminal' | 'candidate-feedback';
export type CommitFaultIdentity = { workId: number; attemptId: number; sessionId: number; itemId: number; createRequestId: string };
export type ChildTerminalFaultIdentity = CommitFaultIdentity & { childRunId: number; childSessionId: number; originToolCallId: number;
  queuedWorkId: number; queuedAttemptId: number; queuedSessionId: number; queuedCreateRequestId: string; stopRequestId: string };
const id = z.number().int().positive().safe(), nullableId = id.nullable();
const taskRow = z.object({ id, conversation_id: id, status: z.string(), abort_requested: z.union([z.literal(0), z.literal(1)]), record: z.string() }).strict();
const toolRow = z.object({ id, run_id: id, session_id: id, native_tool_call_id: z.string(), tool_name: z.string(),
  args_json: z.string(), status: z.string(), result_json: z.string().nullable(), delivery_json: z.string(), cleanup_json: z.string(),
  stopped_at: z.string().nullable(), phase_id: id, feedback_native_entry_id: nullableId,
  feedback_bytes: z.number().int().positive().nullable(), parent_received_model_task_id: nullableId,
  parent_received_at: z.string().nullable() }).strict();
const proofSchema = z.object({
  action: z.enum(['arm', 'inspect', 'clear']), mode: z.enum(['native-input', 'phase-link', 'child-terminal', 'candidate-feedback']),
  installationId: z.string().uuid(), ownerSid: z.string(), controllerReleased: z.literal(true), triggerPresent: z.boolean(),
  phases: z.array(z.object({ id, request_id: z.string(), basis_json: z.string(), native_conversation_id: nullableId,
    native_submission_id: nullableId, closed_at: z.string().nullable() }).strict()),
  contexts: z.array(z.object({ id, phase_id: id, context_json: z.string() }).strict()),
  nativeInputs: z.array(z.object({ id, conversation_id: id, request_id: z.string(), record: z.string() }).strict()),
  inputEntries: z.array(z.object({ id, conversation_id: id, binding_json: z.string() }).strict()),
  bindings: z.array(z.object({ conversation_id: id, request_key: z.string() }).strict()),
  receipt: z.unknown(), attemptCount: z.number().int().nonnegative(), createCount: z.number().int().nonnegative(),
  sessionConversationId: nullableId, runId: nullableId, stopRequestedAt: z.string().nullable(), stoppedAt: z.string().nullable(),
  runs: z.array(z.object({ id, session_id: id, parent_run_id: nullableId, origin_tool_call_id: nullableId, status: z.string(),
    stopped_at: z.string().nullable(), cleanup_json: z.string() }).strict()),
  childTasks: z.array(taskRow), tools: z.array(toolRow),
  queued: z.object({ work_id: id, session_id: id, attempt_id: id, run_id: nullableId, stop_requested_at: z.string().nullable(),
    stopped_at: z.string().nullable(), receipt: z.unknown(), phaseCount: z.number().int().nonnegative(), inputCount: z.number().int().nonnegative() }).strict().nullable(),
  stopReceipt: z.unknown().nullable(), stopRequestJson: z.string().nullable(),
  candidates: z.array(z.object({ id, job_id: id, run_id: id, tool_call_id: id, sequence: id, status: z.string(),
    fields_json: z.string(), lines_json: z.string(), issues_json: z.string(), created_at: z.string() }).strict()),
  candidateEvents: z.array(z.object({ id, candidate_id: id, job_id: id, run_id: id, operation_ref: z.string() }).strict()),
  toolTasks: z.array(taskRow), feedbackEntries: z.array(z.object({ id, conversation_id: id, record: z.string() }).strict()),
}).strict();
export type CommitFaultProof = z.infer<typeof proofSchema>;
const identitySchema = z.object({ workId: id, attemptId: id, sessionId: id, itemId: id,
  createRequestId: z.string().min(1).max(128) }).strict();
const childIdentitySchema = identitySchema.extend({ childRunId: id, childSessionId: id, originToolCallId: id,
  queuedWorkId: id, queuedAttemptId: id, queuedSessionId: id, queuedCreateRequestId: z.string().min(1).max(128),
  stopRequestId: z.string().min(1).max(128) }).strict();
const repository = resolve(import.meta.dirname, '../..');

// This program has three fixed test actions and no arbitrary SQL, root or executable input.
// It is evaluated only by the pinned asset after the explicitly authorized system test starts.
const offlineProgram = String.raw`
import assert from "node:assert/strict";
import {Database} from "bun:sqlite";
import {lstatSync,realpathSync} from "node:fs";
import {basename,dirname,join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
const input=await new Response(Bun.stdin.stream()).json();
assert.deepEqual(Object.keys(input).sort(),["action","mode","original","target"]);
assert.ok(["arm","inspect","clear"].includes(input.action));
assert.ok(["native-input","phase-link","child-terminal","candidate-feedback"].includes(input.mode));
assert.equal(process.env.FLOWMATE_WINDOWS_SERVICE_AUTHORIZED,"1");
const root=process.env.FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_ROOT,file=process.env.FLOWMATE_WINDOWS_SERVICE_INSTALLATION_FILE;
assert.ok(root&&resolve(root)===root&&dirname(root)===realpathSync(tmpdir())&&basename(root).startsWith("flowmate-service-acceptance-"));
assert.ok(!lstatSync(root).isSymbolicLink()&&realpathSync(root)===root);
assert.equal(file,join(root,"data/service-installation.json"));
assert.ok(!lstatSync(file).isSymbolicLink()&&realpathSync(file)===file);
const source=name=>pathToFileURL(join(process.cwd(),"packages/shared/src",name)).href;
const layout=await import(source("service-layout.ts")),identity=await import(source("windows-identity.ts"));
const management=await import(source("service-management.ts")),registration=await import(source("service-registration.ts"));
const {acquireProductControllerLock}=await import(source("controller-lock.ts"));
const {resolveProductPaths,validateProductPaths}=await import(source("paths.ts"));
const need=result=>{assert.equal(result.ok,true,result.ok?"":result.error.code);return result.data};
const original=layout.ServiceInstallationSchema.parse(input.original),t=input.target;
const childMode=input.mode==="child-terminal",candidateMode=input.mode==="candidate-feedback";
assert.deepEqual(Object.keys(t).sort(),(childMode
 ?["attemptId","createRequestId","itemId","sessionId","workId","childRunId","childSessionId","originToolCallId",
   "queuedWorkId","queuedAttemptId","queuedSessionId","queuedCreateRequestId","stopRequestId"]
 :["attemptId","createRequestId","itemId","sessionId","workId"]).sort());
for(const field of ["workId","attemptId","sessionId","itemId"])assert.ok(Number.isSafeInteger(t[field])&&t[field]>0);
assert.ok(typeof t.createRequestId==="string"&&t.createRequestId.length>0&&t.createRequestId.length<=128);
if(childMode){
 for(const field of ["childRunId","childSessionId","originToolCallId","queuedWorkId","queuedAttemptId","queuedSessionId"])assert.ok(Number.isSafeInteger(t[field])&&t[field]>0);
 for(const field of ["stopRequestId","queuedCreateRequestId"])assert.ok(typeof t[field]==="string"&&t[field].length>0&&t[field].length<=128);
 assert.notEqual(t.queuedWorkId,t.workId);assert.notEqual(t.queuedAttemptId,t.attemptId);assert.notEqual(t.queuedSessionId,t.sessionId);
}
assert.equal(original.dataRoot,join(root,"data"));assert.equal(original.runtimeRoot,join(root,"resources/flowmate-runtime"));
assert.equal(original.ownerSid,process.env.FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_SID);
assert.equal(need(await identity.readCurrentWindowsSid()),original.ownerSid);
const current=()=>layout.readServiceInstallation({installationFile:file,runtimeRoot:original.runtimeRoot});
assert.deepEqual(need(await current()),original);
const registered=need(await registration.readServiceRegistration(original.serviceName));
assert.ok(registered);assert.equal(resolve(registered.binaryPath),join(original.runtimeRoot,"service/FlowmateRuntime.exe"));
assert.equal(registered.accountSid,original.ownerSid);
const stopped=need(await management.runServiceAction({action:"stop",installationFile:file,runtimeRoot:original.runtimeRoot}));
assert.equal(stopped.installationId,original.installationId);assert.equal(stopped.serviceName,original.serviceName);
assert.equal(stopped.observedState,"stopped");assert.equal(stopped.controllerReleased,true);
const status=need(await management.runServiceAction({action:"status",installationFile:file,runtimeRoot:original.runtimeRoot}));
assert.equal(status.observedState,"stopped");
const paths=need(resolveProductPaths(original.dataRoot)),lease=need(await acquireProductControllerLock(paths));
let db,proof;
try{
 assert.deepEqual(need(await current()),original);
 need(validateProductPaths(paths));
 assert.ok(lstatSync(paths.databaseFile).isFile()&&!lstatSync(paths.databaseFile).isSymbolicLink());
 assert.equal(realpathSync(paths.databaseFile),paths.databaseFile);
 db=new Database(paths.databaseFile,{create:false,strict:true});
 const work=db.query("SELECT w.id,w.session_id,w.current_attempt_id,w.status,s.runtime_kind,s.durable_conversation_id FROM invoice_works w JOIN sessions s ON s.id=w.session_id WHERE w.id=?").get(t.workId);
 assert.ok(work);assert.equal(work.session_id,t.sessionId);assert.equal(work.current_attempt_id,t.attemptId);
 assert.equal(work.status,"open");assert.equal(work.runtime_kind,"durable");
 const attempt=db.query("SELECT id,work_id,run_id,stop_requested_at,stopped_at FROM invoice_work_attempts WHERE id=? AND work_id=?").get(t.attemptId,t.workId);
 assert.ok(attempt);if(!childMode)assert.equal(attempt.stop_requested_at,null);
 assert.ok(db.query("SELECT id FROM invoice_work_items WHERE id=? AND work_id=?").get(t.itemId,t.workId));
 let childTask;
 if(childMode){
  const children=db.query("SELECT r.id,r.session_id,r.parent_run_id,r.origin_tool_call_id,s.durable_conversation_id FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.kind='subagent' AND r.id=? AND r.parent_run_id=? AND r.origin_tool_call_id=? AND s.runtime_kind='durable'").all(t.childRunId,attempt.run_id,t.originToolCallId);
  assert.equal(children.length,1);const child=children[0];assert.equal(child.session_id,t.childSessionId);assert.ok(child.durable_conversation_id>0);
  const creator=db.query("SELECT n.id FROM fm_durable_conversations v JOIN fm_durable_tasks n ON n.id=v.owner_task_id JOIN tool_calls tc ON tc.native_tool_call_id='durable-task:'||n.id JOIN invoice_work_tool_calls b ON b.tool_call_id=tc.id JOIN invoice_work_phases p ON p.id=b.phase_id WHERE v.id=? AND tc.id=? AND tc.tool_name='Agent' AND tc.run_id=? AND tc.session_id=? AND p.work_id=? AND p.attempt_id=? AND p.item_id=? AND p.native_conversation_id=n.conversation_id AND json_extract(n.record,'$.kind')='pi.tool'").all(child.durable_conversation_id,t.originToolCallId,attempt.run_id,t.sessionId,t.workId,t.attemptId,t.itemId);
  assert.equal(creator.length,1);
  const tasks=db.query("SELECT id,conversation_id,status,abort_requested,record FROM fm_durable_tasks WHERE conversation_id=? AND json_extract(record,'$.kind')='pi.generation'").all(child.durable_conversation_id);
  assert.equal(tasks.length,1);childTask=tasks[0];
  const native=JSON.parse(childTask.record);assert.equal(native.id,childTask.id);
  assert.equal(native.conversationId,child.durable_conversation_id);assert.equal(native.state.status,childTask.status);
  assert.equal(native.abortRequested,childTask.abort_requested===1);
 }
 const name="c09_exact_"+({"native-input":"input","phase-link":"link","child-terminal":"child","candidate-feedback":"feedback"}[input.mode])+"_w"+t.workId+"_a"+t.attemptId;
 const scoped="p.work_id="+t.workId+" AND p.attempt_id="+t.attemptId+" AND p.item_id="+t.itemId
  +" AND w.session_id="+t.sessionId+" AND w.current_attempt_id=a.id AND a.stop_requested_at IS NULL"
  +" AND c.session_id=w.session_id AND json_extract(c.context_json,'$.work.workId')=w.id"
  +" AND json_extract(c.context_json,'$.work.sessionId')=w.session_id"
  +" AND json_extract(c.context_json,'$.phase.phaseId')=p.id AND json_extract(c.context_json,'$.phase.attemptId')=a.id"
  +" AND json_extract(c.context_json,'$.phase.requestId')=p.request_id";
 const joined=" FROM invoice_work_phases p JOIN invoice_works w ON w.id=p.work_id"
  +" JOIN invoice_work_attempts a ON a.id=p.attempt_id AND a.work_id=w.id"
  +" JOIN invoice_work_context_snapshots c ON c.phase_id=p.id AND c.work_id=w.id AND c.attempt_id=a.id";
 const binding=(conversation,key)=>"EXISTS(SELECT 1 FROM fm_durable_documents d JOIN fm_durable_document_revisions r ON r.document_id=d.id"
  +" WHERE d.scope_kind='conversation' AND d.owner_id="+conversation+" AND d.retired_at IS NULL"
  +" AND json_extract(d.record,'$.kind')='flowmate.runtime.binding' AND r.kind='base'"
  +" AND r.seq=(SELECT MAX(last.seq) FROM fm_durable_document_revisions last WHERE last.document_id=d.id)"
  +" AND json_extract(r.content,'$.workId')="+t.workId+" AND json_extract(r.content,'$.sessionId')="+t.sessionId
  +" AND json_extract(r.content,'$.attemptId')="+t.attemptId+" AND json_extract(r.content,'$.requestKey')="+key+")";
 const nativeMatch=(record,conversation,key)=>"json_extract("+record+",'$.type')='input'"
  +" AND json_extract("+record+",'$.conversationId')="+conversation
  +" AND json_extract("+record+",'$.requestId')="+key+" AND "+binding(conversation,key);
 let sql=input.mode==="native-input"
  ?"CREATE TRIGGER "+name+" BEFORE INSERT ON fm_durable_submissions WHEN NOT EXISTS(SELECT 1 FROM fm_durable_submissions old WHERE old.id=NEW.id)"
   +" AND EXISTS(SELECT 1"+joined+" WHERE "+scoped+" AND p.native_submission_id IS NULL AND "
    +"json_extract(NEW.request_id,'$')=json_array(p.attempt_id,p.request_id) AND "
    +nativeMatch("NEW.record","NEW.conversation_id","json_array(p.attempt_id,p.request_id)")+")"
   +" BEGIN SELECT RAISE(ABORT,'c09_exact_native_input_commit'); END"
  :"CREATE TRIGGER "+name+" BEFORE UPDATE OF native_submission_id ON invoice_work_phases"
   +" WHEN OLD.native_submission_id IS NULL AND NEW.native_submission_id IS NOT NULL"
   +" AND NEW.work_id="+t.workId+" AND NEW.attempt_id="+t.attemptId
   +" AND EXISTS(SELECT 1"+joined+" JOIN fm_durable_submissions n ON n.id=NEW.native_submission_id AND n.conversation_id=NEW.native_conversation_id"
    +" WHERE p.id=NEW.id AND "+scoped+" AND json_extract(n.request_id,'$')=json_array(p.attempt_id,p.request_id) AND "
    +nativeMatch("n.record","n.conversation_id","json_array(p.attempt_id,p.request_id)")+")"
   +" BEGIN SELECT RAISE(ABORT,'c09_exact_product_phase_link'); END";
 if(childMode)sql="CREATE TRIGGER "+name+" BEFORE INSERT ON fm_durable_tasks WHEN NEW.id="+childTask.id
  +" AND NEW.conversation_id="+childTask.conversation_id+" AND json_extract(NEW.record,'$.kind')='pi.generation'"
  +" AND NEW.abort_requested=1 AND NEW.status IN ('completing','terminal') AND json_extract(NEW.record,'$.state.outcome.status')='aborted'"
  +" AND EXISTS(SELECT 1"+joined+" JOIN invoice_work_attempt_stop_requests sr ON sr.work_id=w.id AND sr.attempt_id=a.id"
  +" WHERE "+scoped.replace("a.stop_requested_at IS NULL","a.stop_requested_at IS NOT NULL")
  +" AND sr.request_id='"+t.stopRequestId.replaceAll("'","''")+"' AND json_extract(sr.receipt_json,'$.accepted')=1"
  +" AND json_extract(sr.receipt_json,'$.workId')=w.id AND json_extract(sr.receipt_json,'$.attemptId')=a.id"
  +" AND json_extract(sr.receipt_json,'$.requestId')=sr.request_id)"
  +" BEGIN SELECT RAISE(ABORT,'c09_exact_child_terminal_commit'); END";
 if(candidateMode)sql="CREATE TRIGGER "+name+" BEFORE INSERT ON fm_durable_entries WHEN json_extract(NEW.record,'$.kind')='pi.tool-result'"
  +" AND json_extract(NEW.record,'$.model[0].role')='toolResult' AND json_extract(NEW.record,'$.model[0].toolName')='save_invoice_candidate'"
  +" AND EXISTS(SELECT 1"+joined+" JOIN invoice_work_items i ON i.id=p.item_id AND i.work_id=w.id"
  +" JOIN invoice_work_tool_calls b ON b.phase_id=p.id JOIN tool_calls tc ON tc.id=b.tool_call_id AND tc.run_id=a.run_id AND tc.session_id=w.session_id"
  +" JOIN fm_durable_tasks n ON tc.native_tool_call_id='durable-task:'||n.id AND n.conversation_id=p.native_conversation_id"
  +" JOIN invoice_candidates v ON v.tool_call_id=tc.id AND v.run_id=tc.run_id AND v.job_id=i.job_id AND v.id=i.candidate_id"
  +" JOIN business_events e ON e.candidate_id=v.id AND e.run_id=v.run_id AND e.job_id=v.job_id AND e.type='candidate_generated' AND e.result='succeeded' AND e.operation_ref='tool-call-id:'||tc.id"
  +" WHERE "+scoped+" AND tc.tool_name='save_invoice_candidate' AND v.origin='model'"
  +" AND b.feedback_native_entry_id IS NULL AND b.feedback_bytes IS NULL AND json_extract(n.record,'$.kind')='pi.tool'"
  +" AND n.id=json_extract(NEW.record,'$.byTaskId') AND NEW.conversation_id=p.native_conversation_id"
  +" AND json_extract(NEW.record,'$.model[0].toolCallId')=json_extract(n.record,'$.input.callId'))"
  +" BEGIN SELECT RAISE(ABORT,'c09_exact_candidate_feedback_commit'); END";
 const triggers=db.query("SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name GLOB 'c09_exact_*'").all();
 assert.ok(triggers.every(trigger=>trigger.name===name),"another exact fault remains; preserve it");
 const own=triggers.find(trigger=>trigger.name===name);
 if(own)assert.equal(own.sql.trim().replace(/;$/,""),sql);
 const snapshot=()=>{
  const phases=db.query("SELECT id,request_id,basis_json,native_conversation_id,native_submission_id,closed_at FROM invoice_work_phases WHERE work_id=? AND attempt_id=? ORDER BY id").all(t.workId,t.attemptId);
  const contexts=db.query("SELECT id,phase_id,context_json FROM invoice_work_context_snapshots WHERE work_id=? AND attempt_id=? AND session_id=? ORDER BY id").all(t.workId,t.attemptId,t.sessionId);
  for(const c of contexts){const value=JSON.parse(c.context_json);assert.equal(value.work.workId,t.workId);assert.equal(value.work.sessionId,t.sessionId);
   assert.equal(value.phase.attemptId,t.attemptId);assert.equal(value.phase.phaseId,c.phase_id);assert.equal(value.item.itemId,t.itemId)}
  const keys="SELECT json_array(attempt_id,request_id) FROM invoice_work_phases WHERE work_id=? AND attempt_id=?";
  const nativeInputs=db.query("SELECT id,conversation_id,request_id,record FROM fm_durable_submissions WHERE json_extract(record,'$.type')='input' AND json_extract(record,'$.requestId') IN ("+keys+") ORDER BY id").all(t.workId,t.attemptId);
  const inputEntries=db.query("SELECT id,conversation_id,json_extract(record,'$.data') AS binding_json FROM fm_durable_entries WHERE json_extract(record,'$.kind')='flowmate.input' AND json_extract(record,'$.data.workId')=? AND json_extract(record,'$.data.sessionId')=? AND json_extract(record,'$.data.attemptId')=? ORDER BY id").all(t.workId,t.sessionId,t.attemptId);
  const bindings=db.query("SELECT d.owner_id AS conversation_id,json_extract(r.content,'$.requestKey') AS request_key FROM fm_durable_documents d JOIN fm_durable_document_revisions r ON r.document_id=d.id WHERE d.scope_kind='conversation' AND d.retired_at IS NULL AND json_extract(d.record,'$.kind')='flowmate.runtime.binding' AND r.kind='base' AND r.seq=(SELECT MAX(last.seq) FROM fm_durable_document_revisions last WHERE last.document_id=d.id) AND json_extract(r.content,'$.workId')=? AND json_extract(r.content,'$.sessionId')=? AND json_extract(r.content,'$.attemptId')=?").all(t.workId,t.sessionId,t.attemptId);
  const receipt=db.query("SELECT receipt_json FROM invoice_work_operations WHERE work_id=? AND kind='create' AND request_id=?").get(t.workId,t.createRequestId);
   assert.ok(receipt);const received=JSON.parse(receipt.receipt_json);
   assert.equal(received.workId,t.workId);assert.equal(received.sessionId,t.sessionId);
   assert.equal(received.requestId,t.createRequestId);assert.equal(received.execution.attempt.attemptId,t.attemptId);
   for(const row of nativeInputs)assert.equal(JSON.parse(row.request_id),JSON.parse(row.record).requestId);
   const runs=attempt.run_id===null?[]:db.query("SELECT id,session_id,parent_run_id,origin_tool_call_id,status,stopped_at,cleanup_json FROM runs WHERE id=? OR parent_run_id=? ORDER BY id").all(attempt.run_id,attempt.run_id);
   const tools=childMode||candidateMode?db.query("SELECT tc.id,tc.run_id,tc.session_id,tc.native_tool_call_id,tc.tool_name,tc.args_json,tc.status,tc.result_json,tc.delivery_json,tc.cleanup_json,tc.stopped_at,b.phase_id,b.feedback_native_entry_id,b.feedback_bytes,b.parent_received_model_task_id,b.parent_received_at FROM tool_calls tc JOIN invoice_work_tool_calls b ON b.tool_call_id=tc.id JOIN invoice_work_phases p ON p.id=b.phase_id WHERE p.work_id=? AND p.attempt_id=? AND tc.tool_name=? ORDER BY tc.id").all(t.workId,t.attemptId,childMode?"Agent":"save_invoice_candidate"):[];
   const candidates=candidateMode?db.query("SELECT v.id,v.job_id,v.run_id,v.tool_call_id,v.sequence,v.status,v.fields_json,v.lines_json,v.issues_json,v.created_at FROM invoice_candidates v JOIN tool_calls tc ON tc.id=v.tool_call_id JOIN invoice_work_tool_calls b ON b.tool_call_id=tc.id JOIN invoice_work_phases p ON p.id=b.phase_id WHERE p.work_id=? AND p.attempt_id=? ORDER BY v.id").all(t.workId,t.attemptId):[];
   const candidateEvents=candidateMode?db.query("SELECT e.id,e.candidate_id,e.job_id,e.run_id,e.operation_ref FROM business_events e JOIN invoice_candidates v ON v.id=e.candidate_id JOIN tool_calls tc ON tc.id=v.tool_call_id JOIN invoice_work_tool_calls b ON b.tool_call_id=tc.id JOIN invoice_work_phases p ON p.id=b.phase_id WHERE p.work_id=? AND p.attempt_id=? AND e.type='candidate_generated' AND e.operation_ref='tool-call-id:'||tc.id ORDER BY e.id").all(t.workId,t.attemptId):[];
   const toolTasks=candidateMode?db.query("SELECT n.id,n.conversation_id,n.status,n.abort_requested,n.record FROM fm_durable_tasks n JOIN tool_calls tc ON tc.native_tool_call_id='durable-task:'||n.id JOIN invoice_work_tool_calls b ON b.tool_call_id=tc.id JOIN invoice_work_phases p ON p.id=b.phase_id WHERE p.work_id=? AND p.attempt_id=? AND tc.tool_name='save_invoice_candidate' AND json_extract(n.record,'$.kind')='pi.tool' ORDER BY n.id").all(t.workId,t.attemptId):[];
   const feedbackEntries=candidateMode?db.query("SELECT e.id,e.conversation_id,e.record FROM fm_durable_entries e JOIN fm_durable_tasks n ON n.id=json_extract(e.record,'$.byTaskId') JOIN tool_calls tc ON tc.native_tool_call_id='durable-task:'||n.id JOIN invoice_work_tool_calls b ON b.tool_call_id=tc.id JOIN invoice_work_phases p ON p.id=b.phase_id WHERE p.work_id=? AND p.attempt_id=? AND tc.tool_name='save_invoice_candidate' AND json_extract(e.record,'$.kind')='pi.tool-result' AND json_extract(e.record,'$.model[0].toolCallId')=json_extract(n.record,'$.input.callId') ORDER BY e.id").all(t.workId,t.attemptId):[];
   let queued=null,stopReceipt=null,stopRequestJson=null;
   if(childMode){
    queued=db.query("SELECT w.id AS work_id,w.session_id,a.id AS attempt_id,a.run_id,a.stop_requested_at,a.stopped_at,o.receipt_json FROM invoice_works w JOIN sessions s ON s.id=w.session_id JOIN invoice_work_attempts a ON a.id=w.current_attempt_id AND a.work_id=w.id JOIN invoice_work_operations o ON o.work_id=w.id AND o.kind='create' AND o.request_id=? WHERE w.id=? AND w.status='open' AND s.runtime_kind='durable'").get(t.queuedCreateRequestId,t.queuedWorkId);
    assert.ok(queued);assert.equal(queued.attempt_id,t.queuedAttemptId);assert.equal(queued.session_id,t.queuedSessionId);
    const {receipt_json,...row}=queued;queued={...row,receipt:JSON.parse(receipt_json),
     phaseCount:db.query("SELECT count(*) AS n FROM invoice_work_phases WHERE work_id=? AND attempt_id=?").get(t.queuedWorkId,t.queuedAttemptId).n,
     inputCount:db.query("SELECT count(*) AS n FROM fm_durable_entries WHERE json_extract(record,'$.kind')='flowmate.input' AND json_extract(record,'$.data.workId')=?").get(t.queuedWorkId).n};
    assert.equal(queued.receipt.workId,t.queuedWorkId);assert.equal(queued.receipt.sessionId,t.queuedSessionId);
    assert.equal(queued.receipt.requestId,t.queuedCreateRequestId);assert.equal(queued.receipt.execution.attempt.attemptId,t.queuedAttemptId);
    assert.equal(queued.receipt.execution.kind,"queued");assert.equal(queued.receipt.execution.authorizationAccepted,true);
    const stop=db.query("SELECT receipt_json,request_json FROM invoice_work_attempt_stop_requests WHERE work_id=? AND attempt_id=? AND request_id=?").get(t.workId,t.attemptId,t.stopRequestId);
    if(stop){stopReceipt=JSON.parse(stop.receipt_json);stopRequestJson=stop.request_json;assert.equal(stopReceipt.workId,t.workId);assert.equal(stopReceipt.attemptId,t.attemptId);assert.equal(stopReceipt.requestId,t.stopRequestId)}
   }
   return{phases,contexts,nativeInputs,inputEntries,bindings,receipt:received,runId:attempt.run_id,runs,
    tools,candidates,candidateEvents,toolTasks,feedbackEntries,queued,stopReceipt,stopRequestJson,childTasks:childMode?[childTask]:[],
    stopRequestedAt:attempt.stop_requested_at,stoppedAt:attempt.stopped_at,
   attemptCount:db.query("SELECT count(*) AS n FROM invoice_work_attempts WHERE work_id=?").get(t.workId).n,
   createCount:db.query("SELECT count(*) AS n FROM invoice_work_operations WHERE work_id=? AND kind='create'").get(t.workId).n,
   sessionConversationId:db.query("SELECT durable_conversation_id AS id FROM sessions WHERE id=?").get(t.sessionId).id};
 };
 let facts=snapshot();
 if(input.action==="arm"&&childMode){
  assert.equal(own,undefined);assert.equal(attempt.stop_requested_at,null);assert.equal(attempt.stopped_at,null);
  assert.equal(facts.phases.length,1);assert.equal(facts.contexts.length,1);assert.ok(facts.phases[0].native_submission_id>0);
  assert.equal(facts.phases[0].closed_at,null);assert.equal(facts.tools.length,1);assert.equal(facts.tools[0].id,t.originToolCallId);
  assert.equal(childTask.status,"pending");assert.equal(childTask.abort_requested,0);assert.equal(facts.stopReceipt,null);
  assert.equal(facts.queued.run_id,null);assert.equal(facts.queued.phaseCount,0);assert.equal(facts.queued.inputCount,0);
  assert.equal(facts.queued.stop_requested_at,null);assert.equal(facts.queued.stopped_at,null);
  assert.equal(facts.runs.length,2);assert.ok(facts.runs.some(run=>run.id===t.childRunId&&run.session_id===t.childSessionId));
  for(const run of facts.runs){assert.equal(run.stopped_at,null);assert.equal(JSON.parse(run.cleanup_json).stopped,false)}
  db.exec(sql);
 }else if(input.action==="arm"){
  assert.equal(own,undefined);assert.equal(attempt.run_id,null);assert.equal(facts.phases.length,0);assert.equal(facts.contexts.length,0);
  assert.equal(facts.nativeInputs.length,0);assert.equal(facts.bindings.length,0);assert.equal(facts.sessionConversationId,null);
  db.exec(sql);
 }else if(input.action==="clear"&&childMode){
  assert.ok(own);assert.ok(attempt.stop_requested_at);assert.equal(attempt.stopped_at,null);
  assert.ok(facts.stopReceipt&&facts.stopReceipt.accepted&&!facts.stopReceipt.stopConfirmed);
  assert.equal(JSON.parse(facts.stopRequestJson).requestId,t.stopRequestId);
  assert.equal(facts.phases.length,1);assert.equal(facts.phases[0].closed_at,null);
  assert.equal(childTask.abort_requested,1);assert.ok(["pending","running","waiting","sleeping"].includes(childTask.status));
  assert.equal(facts.queued.run_id,null);assert.equal(facts.queued.phaseCount,0);assert.equal(facts.queued.inputCount,0);
  assert.equal(facts.queued.stop_requested_at,null);assert.equal(facts.queued.stopped_at,null);
  for(const run of facts.runs){assert.equal(run.stopped_at,null);assert.equal(JSON.parse(run.cleanup_json).stopped,false)}
  db.exec("DROP TRIGGER "+name);
 }else if(input.action==="clear"&&candidateMode){
  assert.ok(own);assert.equal(facts.phases.length,1);assert.equal(facts.contexts.length,1);assert.equal(facts.phases[0].closed_at,null);
  assert.equal(facts.candidates.length,1);assert.equal(facts.candidateEvents.length,1);assert.equal(facts.tools.length,1);
  assert.equal(facts.toolTasks.length,1);assert.ok(["pending","running","waiting","sleeping"].includes(facts.toolTasks[0].status));
  assert.equal(facts.tools[0].status,"succeeded");assert.ok(facts.tools[0].result_json);
  assert.equal(facts.tools[0].feedback_native_entry_id,null);assert.equal(facts.tools[0].feedback_bytes,null);
  assert.equal(facts.feedbackEntries.length,0);assert.equal(facts.candidates[0].tool_call_id,facts.tools[0].id);
  assert.equal(facts.candidateEvents[0].candidate_id,facts.candidates[0].id);
  db.exec("DROP TRIGGER "+name);
 }else if(input.action==="clear"){
  assert.ok(own);assert.equal(facts.phases.length,1);assert.equal(facts.contexts.length,1);
  assert.equal(facts.phases[0].native_submission_id,null);assert.equal(facts.phases[0].closed_at,null);
  assert.equal(facts.bindings.length,1);assert.equal(facts.bindings[0].request_key,JSON.stringify([t.attemptId,facts.phases[0].request_id]));
  assert.equal(facts.nativeInputs.length,input.mode==="native-input"?0:1);
  if(input.mode==="native-input")assert.equal(facts.inputEntries.length,0);
  else assert.equal(facts.nativeInputs[0].conversation_id,facts.bindings[0].conversation_id);
  assert.equal(facts.sessionConversationId,null);
  db.exec("DROP TRIGGER "+name);
 }
 facts=snapshot();
 proof={action:input.action,mode:input.mode,installationId:original.installationId,ownerSid:original.ownerSid,
  controllerReleased:true,triggerPresent:!!db.query("SELECT name FROM sqlite_schema WHERE type='trigger' AND name=?").get(name),...facts};
}finally{
  try{if(db)db.close()}finally{
   const released=await lease.release();assert.equal(released.ok,true,"original root lease release unconfirmed");
  }
}
console.log(JSON.stringify(proof));
`;

function originalInstallation() {
  assert.equal(process.env.FLOWMATE_WINDOWS_SERVICE_AUTHORIZED, '1');
  const root = process.env.FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_ROOT, file = process.env.FLOWMATE_WINDOWS_SERVICE_INSTALLATION_FILE;
  assert.ok(root && resolve(root) === root && dirname(root) === realpathSync(tmpdir())
    && basename(root).startsWith('flowmate-service-acceptance-') && !lstatSync(root).isSymbolicLink() && realpathSync(root) === root);
  assert.equal(file, join(root, 'data/service-installation.json'));
  assert.ok(file && !lstatSync(file).isSymbolicLink() && realpathSync(file) === file);
  const original = ServiceInstallationSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  assert.equal(original.ownerSid, process.env.FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_SID);
  assert.equal(original.dataRoot, join(root, 'data')); assert.equal(original.runtimeRoot, join(root, 'resources/flowmate-runtime'));
  assert.equal(original.enabled, true);
  return original;
}

export function createSystemCommitFault(mode: CommitFaultMode) {
  const original = originalInstallation();
  const run = (action: 'arm' | 'inspect' | 'clear', raw: CommitFaultIdentity | ChildTerminalFaultIdentity) => {
    assert.deepEqual(originalInstallation(), original);
    const target = (mode === 'child-terminal' ? childIdentitySchema : identitySchema).parse(raw), env: Record<string, string> = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR',
      'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'FLOWMATE_WINDOWS_SERVICE_AUTHORIZED', 'FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_ROOT',
      'FLOWMATE_WINDOWS_SERVICE_INSTALLATION_FILE', 'FLOWMATE_WINDOWS_SERVICE_ACCEPTANCE_SID'])
      if (process.env[key]) env[key] = process.env[key]!;
    const output = execFileSync(join(original.runtimeRoot, 'bin/bun.exe'), ['--no-env-file', '-e', offlineProgram],
      { cwd: repository, env, input: JSON.stringify({ action, mode, original, target }), windowsHide: true,
        timeout: 90_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const proof = proofSchema.parse(JSON.parse(output));
    assert.equal(proof.action, action); assert.equal(proof.mode, mode);
    assert.equal(proof.installationId, original.installationId); assert.equal(proof.ownerSid, original.ownerSid);
    return proof;
  };
  return { arm: (target: CommitFaultIdentity | ChildTerminalFaultIdentity) => run('arm', target),
    inspect: (target: CommitFaultIdentity | ChildTerminalFaultIdentity) => run('inspect', target),
    clear: (target: CommitFaultIdentity | ChildTerminalFaultIdentity) => run('clear', target) };
}
