import { CaseEvaluationFaultProfileSchema, type CaseEvaluationFaultProfile } from '@flowmate/contracts';

export function createCaseEvaluationFault(value?:CaseEvaluationFaultProfile){
  if(!value)return undefined;
  const profile=CaseEvaluationFaultProfileSchema.parse(value);let activated=false;
  return {profile,async commitGate(phase:'before-commit'|'after-commit',name:string,signal:AbortSignal){
    if(profile.id!=='case-save-cancel-race'||profile.gate!==phase||name!=='save_invoice_candidate'||signal.aborted)return;
    await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));
  },activate(name:string){
    if(activated||name!==(profile.id==='case-save-delivery-loss'?'save_invoice_candidate':'read_invoice_evidence'))return false;
    activated=true;return true;
  }};
}
