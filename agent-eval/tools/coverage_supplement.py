"""Explicit missing storage/authority matrices, separate from Agent tasks.

Rows name concrete fixture mutations, real command boundaries and independent
readbacks. They are design material and cannot execute or create observations.
"""
from copy import deepcopy


MATRICES = [
 ('private-work-roots','operations','P11',['CRIT-3.23.3-01'],
  {'parent':'real_parent_run','child':'actual_Agent_tool_child','requiredRoot':'configured owned temporary work root',
   'forbiddenRoots':['immutable_source_root','quality_data_root'],'canaries':['PARENT-WORK-ONLY','CHILD-WORK-ONLY']},
  'Create real parent and approved read-only child through product entry. Independently resolve cwd and actual filesystem ownership, write isolated synthetic canaries to each permitted work directory and inspect all reads/writes through complete probes. Attempt cwd redirection to source/quality roots and links outside owned temp root; refuse before tool/model delivery. Normal own-root operation remains legal.',
  {'sharedMutableParentChildDirectories':0,'cwdOutsideOwnedWorkRoot':0,'sourceOrQualityRootWrites':0,'crossRunCanaryReads':0,'legalOwnRootOperations':2}),
 ('private-agent-directory','operations','P9',['CRIT-3.23.3-02'],
  {'agentDir':'fresh instance-private directory','approvedFiles':['selected_prompt','selected_skill'],
   'forbiddenFiles':['credential_canary','old_native_history','global_unselected_skill'],'globalDiscoveryCanary':'GLOBAL-UNSELECTED-421'},
  'Assemble approved projection into private agentDir, capture complete directory listing and actual loader file-open trace. Place separate synthetic forbidden materials in isolated global config/history areas. Start actual native instance, inspect effective discovery roots and outbound request; approved selected Skill positive control must load. No real credentials are read.',
  {'privateDirectoryForbiddenFiles':0,'globalUnselectedDiscoveryLoads':0,'forbiddenCanariesInRequests':0,'approvedSkillLoads':1,'sharedAgentDirectories':0}),
 ('action-identity', 'actions', 'P12',
  ['CRIT-3.24-action-dispatch/logical-identity','CRIT-3.24-action-dispatch/cross-job-uniqueness','CRIT-3.24.1-action-dedup/cross-job'],
  {'document':'INV-A','organization':'ORG-A','environment':'local-test','jobs':['J1','J2'],
   'variants':['successful_prior_job','unknown_prior_job_payload_changed','unknown_prior_job_random_key','wrong_environment','wrong_organization','different_document_control']},
  'Create J1 action through trusted preview/approval and perform local target send. For each isolated variant use J2 with same document, changed payload/client random key or incorrect target; rederive logical key on server. The separate-document control receives its own valid approval and target identity. Capture all jobs, original action references, server key components, admissions and complete target ledger.',
  {'sameDocumentNewLogicalActions':0,'clientChosenIdentityAccepted':0,'wrongTargetAdmissions':0,'differentDocumentLogicalActions':1,'missingServerKeyComponents':0}),
 ('attempt-transition','actions','P12', ['CRIT-3.24-action-dispatch/active-attempt'],
  {'action':'ACT-A','oldAttempt':'T1','oldState':'UNKNOWN','newAttempt':'T2','barrier':'two eligible retry claimers','fault':'rollback between old relinquish and new insert'},
  'First race two real retry claimers under current approved idempotent-target retry. Inspect one active attempt, linked predecessor and atomic relinquish/create. Repeat with transaction fault: retain old active T1 and no T2; successful normal control commits both changes.',
  {'maximumActiveAttempts':1,'unlinkedNewAttempts':0,'rollbackNewAttempts':0,'rollbackOldActiveAttempts':1,'successfulAtomicTransitions':1}),
 ('safe-retry-controls','actions','P12',['CRIT-3.24-action-dispatch/safe-retry','CRIT-3.24.1-action-dedup/legal-controls'],
  {'action':'ACT-A','oldAttempt':'UNKNOWN','targetContract':'same key is durably idempotent','variants':['idempotent_target_valid','authoritative_not_applied_valid','old_worker_alive','approval_revoked','non_authoritative_empty_search']},
  'Cause a real local send response loss, retain UNKNOWN. In each fresh variant independently establish target contract or signed authoritative no-effect receipt, old process termination and current approval. Hold final send admission, revoke only in its variant. Positive idempotent control reuses exact logical key with a new attempt/approval; count requests and target effects separately.',
  {'validRetryVariants':2,'invalidRetryAdmissions':0,'maximumBusinessEffectsPerVariant':1,'overwrittenUnknownAttempts':0,'retriesMissingCurrentApprovalOrOldStopReceipt':0}),
 ('assessment-basis','workflow','P8',['CRIT-3.24-assessment-basis/full-basis','CRIT-3.24-assessment-basis/immutable-snapshot'],
  {'revision':'r1','fieldsHash':'captured_from_canonical_fields','mutations':['fields','assessment','target','payload','rule_version'],'faults':['same_snapshot_id_different_body','wrong_revision_fields_hash']},
  'Build snapshot and independently recompute canonical basis digest from actual fields, assessment, target, payload and rule versions. Mutate one component per fresh fixture and assert a new basis; keep original snapshot bytes immutable. Reject reuse of identity with changed body and mismatched Revision/fieldsHash; exact replay is legal.',
  {'componentMutationsChangingBasis':5,'oldSnapshotByteChanges':0,'invalidSnapshotAdmissions':0,'exactReplayAdditionalSnapshots':0,'independentDigestMismatches':0}),
 ('delegation-slots','subagents','P11',['CRIT-3.24-child-delegation/slot-identity','CRIT-3.24-child-delegation/pending-first','CRIT-3.24-child-delegation/trusted-binding','CRIT-3.24-child-delegation/failure-retention','CRIT-3.24.1-delegation-identity/distinct-slots','CRIT-3.24.1-delegation-identity/out-of-order-binding','CRIT-3.24.1-delegation-identity/failure-recovery'],
  {'parentToolCall':'actual_native_Agent_call','slots':[0,1],'completionOrder':[1,0],'variants':['both_succeed','slot_1_startup_failure','duplicate_slot_0'],
   'policyGate':'Run multi-slot variant only when approved plugin mode permits it; otherwise retain conditional blocker. Do not enable forbidden parallel mode in initial product policy.'},
  'Actual main Agent tool invokes the approved multi-slot contract. Commit each pending identity before dispatch; return actual plugin/Session identities out of order. Repeat slot0 registration; retain both slots and failed slot disposition if slot1 fails. Restore pending state by query without replacement delegation; nearest-created-Session fallback is forbidden.',
  {'dispatchBeforePendingCommit':0,'sameSlotAdditionalExecutions':0,'distinctSlotIdentityCount':2,'wrongSlotSessionAssociations':0,'lostFailedSlotRecords':0,'restoreReplacementDelegations':0}),
 ('context-publication','context','P5',['CRIT-3.24-context-snapshot/atomic-publication','CRIT-3.24-context-snapshot/hash-and-identity','CRIT-3.24-context-snapshot/no-hash-cycle','CRIT-3.24.1-context-attribution/failed-publication'],
  {'oldSnapshot':'A','newSnapshot':'B','run':'RUN-A','variants':['pointer_update_failure','generation_changed','same_id_exact_body','same_id_changed_body','valid_publish'],
   'canonicalBody':'selected document/role facts only; exclude reverse RuntimeSnapshot digest'},
  'Build A via public Context operation and record old candidate, RuntimeSnapshot and Run pointer. Publish B under each isolated mutation; inspect one transaction for body+pointer. Recompute canonical body hash and ownership from raw bytes; identical replay is idempotent, changed same-ID body rejected. Failure preserves old references and digest without publishing B.',
  {'partialSnapshotPointerCommits':0,'staleGenerationPublications':0,'sameIdChangedBodyAdmissions':0,'exactReplayAdditionalBodies':0,'failedPublishOldReferenceChanges':0,'reverseRuntimeDigestDependencies':0,'canonicalBodyColumnMismatches':0}),
 ('context-recovery','context','P5',['CRIT-3.24-context-snapshot/database-recovery','CRIT-3.24-context-snapshot/immutable-history','CRIT-3.24.1-context-attribution/recovery-stability','CRIT-3.24.1-context-attribution/reject-forged-or-cross-run'],
  {'snapshots':['A','B'],'requestSnapshot':'A','currentPointer':'B','candidateSnapshot':'A','exportFiles':'absent','foreignExistingSnapshot':'RUN-B-SNAPSHOT'},
  'Create actual request/candidate from A, publish B, close and remove only owned temporary export files. Restore from SQLite and compare request/tool/candidate links plus canonical bodies. Submit an existing foreign-Run snapshot FK through trusted product caller and a forged model ID through normal entry; both rejected; authorized A read remains legal.',
  {'restoredRequestToolCandidateLinkMismatches':0,'requiredExportFileReads':0,'crossRunForeignKeyAdmissions':0,'modelClaimedIdsAccepted':0,'authorizedReadFailures':0,'reverseRuntimeDigestDependencies':0}),
 ('approval-atomic-typed','actions','P12',['CRIT-3.24-formal-approval/atomic-decision','CRIT-3.24-formal-approval/frozen-action','CRIT-3.24-formal-approval/typed-command'],
  {'action':'ACT-A','principal':'trusted_qualified_user','basis':'captured_current_basis','variants':['inputId_as_approval','interactionId_as_approval','wrong_basis','wrong_principal','audit_commit_failure','valid_formal_approval']},
  'Freeze an unsent Action, then attempt each typed command under isolated trusted identities. Inspect approval actor/action/version/basis exactly. Fault the audit write during approve transaction: approval, unsent action state and audit must all roll back. Valid qualified formal command commits all three; chat/field confirmation cannot create approval.',
  {'typeConfusionApprovals':0,'wrongActorOrBasisApprovals':0,'partialApprovalActionAuditCommits':0,'validFormalDecisions':1,'approvalBasisOrVersionMismatches':0}),
 ('evidence-reapproval','actions','P12',['CRIT-3.24.1-assessment-consistency/approval-invalidation'],
  {'fields':'unchanged','evidenceVersions':[1,2],'approvals':['A1','A2']},
  'Approve frozen payload with evidence v1. Refresh evidence to v2 without field change and verify A1 invalidation. Reassess and freeze new basis, obtain qualified A2 and perform local valid send; retain A1 history and send-time A2 identity.',
  {'oldApprovalAdmittedAfterEvidenceChange':0,'newApprovedControlEffects':1,'sendApprovalIdentity':'A2','historicalApprovalRecordsDeleted':0}),
 ('human-adoption-transaction','workflow','P8',['CRIT-3.24-human-interaction/atomic-adoption'],
  {'interaction':'I-A','revision':'r1','answer':'supplier registration 9988','faultPositions':['revision_insert','step_attempt_update','job_update','audit_insert']},
  'Answer a current waiting interaction through authorized human command. Inject each transaction failure and inspect interaction disposition, accepted facts/revision, StepAttempt, Job and audit before/after. Successful control commits linked facts once; repeat same command is idempotent.',
  {'partialInteractionRevisionStepJobAuditCommits':0,'failedAnswerFactsAccepted':0,'successfulLinkedAdoptions':1,'duplicateAnswerExtraRevisions':0}),
 ('dataset-restore-identity','foundation','P0',['CRIT-3.24-input-dataset/immutable-input'],
  {'workspace':'W-A','datasetVersion':1,'document':'DOC-A','laterImportedDatasetVersion':2,'ownedSource':'pinned content.json bytes'},
  'Import the actual pinned immutable source, create Job reference to dataset v1, import v2 and restart repository access. In one recovered Job compare Workspace owner, original manifest version, document identity and independently read bytes/digest; reject same path replacement and foreign owner reference.',
  {'recoveredOwnerVersionDocumentDigestMismatches':0,'changedBytesAccepted':0,'foreignOwnerReads':0,'silentUpgradeToLatest':0}),
 ('native-roundtrip-types','memory','P6',['CRIT-3.24-native-memory/legal-root','CRIT-3.24-native-memory/native-roundtrip','CRIT-3.24.1-session-integrity/legal-roundtrip'],
  {'entryTypes':['header','message','model','label','extension','custom','compaction','branch_summary'],'rootControls':['null_parent','null_current_position','documented_sentinel'],
   'nativeMode':'Create each supported type using the pinned actual SDK; unavailable type blocks this variant, never fabricate a successful history.'},
  'Capture raw canonical native entries and type inventory from actual SDK operations. Persist, close, clear owned native directories and restore every declared type plus legal roots. Recompute body digests and compare unknown/native extension fields, tree, order and current cursor; do not treat set membership as sequence correctness.',
  {'requiredTypesAbsentWithoutBlocker':0,'canonicalRoundtripByteMismatches':0,'legalRootFalseRejections':0,'cursorOrParentMismatches':0}),
 ('native-reference-order','memory','P6',['CRIT-3.24-native-memory/references','CRIT-3.24-native-memory/tree-and-order','CRIT-3.24.1-session-integrity/invalid-history'],
  {'referenceTypes':['parent','compaction','branch','label','custom','current_position'],'foreignSession':'existing foreign entries','orderVariants':['duplicate_sequence','noncyclic_invalid_order','gap','valid_paginated_history']},
  'Create two real SDK histories. In isolated storage fault copies replace each typed reference with an existing foreign-Session entry and try restore; separately create noncyclic wrong order/duplicate/gap. Preserve corruption evidence and block execution. Valid complete paginated history restores in declared sequence.',
  {'crossSessionTypedReferencesAccepted':0,'invalidOrderRestores':0,'corruptHistoryRequests':0,'corruptionEvidenceDeleted':0,'validSequenceRestores':1}),
 ('persistence-abort','memory','P6',['CRIT-3.24-persistence-binding/poison','CRIT-3.24.1-session-integrity/poison-on-failure'],
  {'activeBinding':'B1','fault':'native entry persistence fails during real active stream','carrier':'embedded'},
  'Hold active Provider stream, fail history transaction after native entry arrives, and observe storage-failure callback plus actual Pi abort invocation receipt before resource cleanup. Probe new request and tool after poisoning; retain unsaved diagnostic disposition, resume only fresh authorized binding.',
  {'actualAbortInvocations':1,'newRequestsOnPoisonedBinding':0,'newToolsOnPoisonedBinding':0,'unsavedEntriesClaimedCommitted':0}),
 ('session-input-delivery','sessions','P4',['CRIT-3.24-session-input/delivery-state','CRIT-3.24-session-input/ownership'],
  {'inputId':'INPUT-A','job':'JOB-A','session':'SESSION-A','run':'RUN-A','variants':['wrong_job','wrong_session','wrong_run','crash_after_native_delivery_before_ack','valid_delivery']},
  'Create actual identities, submit input through product API, reject mismatched ownership before native delivery. Crash after independent SDK delivery receipt but before acknowledgement; recovery queries original input state and records delivery_unknown without resending. Legal matching control delivers once and retains consumption separately.',
  {'ownershipMismatchNativeDeliveries':0,'unknownDeliveryAutomaticResends':0,'unknownDeliveryState':'delivery_unknown','validInputDeliveries':1,'admissionMisreportedAsConsumption':0}),
 ('session-identity-pagination','sessions','P4',['CRIT-3.24-session-lifecycle/identity','CRIT-3.24-session-lifecycle/pagination','CRIT-3.24.1-session-integrity/identity-initialization'],
  {'sessions':['S1','S2'],'nativeIds':'captured actual SDK IDs','pageSize':2,'nativeEntryCount':5,'variants':['duplicate_pi_id','wrong_event_binding','missing_middle_page','valid']},
  'Initialize two actual Sessions with captured Pi identities. Attempt binding same Pi ID to both products and deliver an event from wrong native session. Restore five real entries in pages of two; detect missing middle page through sequence/cursor checks, not set count only. Legal full restore compares ordered body hashes and event-to-Session join.',
  {'duplicatePiIdentityCommits':0,'wrongNativeEventsAccepted':0,'gappedSequenceRestores':0,'validRestoredEntryCount':5,'validEventJoinMismatches':0}),
]


# A check claims only the named requirement condition. These explicit suffixes
# refer to the authored requirement list above, not title/keyword inference.
FIELD_REQUIREMENTS = {
 'action-identity': {
  'sameDocumentNewLogicalActions':['cross-job-uniqueness','cross-job'],
  'clientChosenIdentityAccepted':['logical-identity','cross-job'],
  'wrongTargetAdmissions':['logical-identity'],
  'differentDocumentLogicalActions':['cross-job-uniqueness','cross-job'],
  'missingServerKeyComponents':['logical-identity']},
 'safe-retry-controls': {
  'validRetryVariants':['safe-retry','legal-controls'],'invalidRetryAdmissions':['safe-retry'],
  'maximumBusinessEffectsPerVariant':['safe-retry','legal-controls'],
  'overwrittenUnknownAttempts':['safe-retry'],'retriesMissingCurrentApprovalOrOldStopReceipt':['safe-retry']},
 'assessment-basis': {
  'componentMutationsChangingBasis':['full-basis'],'oldSnapshotByteChanges':['immutable-snapshot'],
  'invalidSnapshotAdmissions':['immutable-snapshot'],'exactReplayAdditionalSnapshots':['immutable-snapshot'],
  'independentDigestMismatches':['full-basis']},
 'delegation-slots': {
  'dispatchBeforePendingCommit':['pending-first'],'sameSlotAdditionalExecutions':['slot-identity','distinct-slots'],
  'distinctSlotIdentityCount':['slot-identity','distinct-slots'],
  'wrongSlotSessionAssociations':['trusted-binding','out-of-order-binding'],
  'lostFailedSlotRecords':['failure-retention','failure-recovery'],
  'restoreReplacementDelegations':['failure-retention','failure-recovery']},
 'context-publication': {
  'partialSnapshotPointerCommits':['atomic-publication','failed-publication'],
  'staleGenerationPublications':['atomic-publication'],'sameIdChangedBodyAdmissions':['hash-and-identity'],
  'exactReplayAdditionalBodies':['hash-and-identity'],'failedPublishOldReferenceChanges':['failed-publication'],
  'reverseRuntimeDigestDependencies':['no-hash-cycle'],'canonicalBodyColumnMismatches':['hash-and-identity']},
 'context-recovery': {
  'restoredRequestToolCandidateLinkMismatches':['immutable-history','recovery-stability'],
  'requiredExportFileReads':['database-recovery'],'crossRunForeignKeyAdmissions':['reject-forged-or-cross-run'],
  'modelClaimedIdsAccepted':['reject-forged-or-cross-run'],'authorizedReadFailures':['database-recovery','reject-forged-or-cross-run'],
  'reverseRuntimeDigestDependencies':['recovery-stability']},
 'approval-atomic-typed': {
  'typeConfusionApprovals':['typed-command'],'wrongActorOrBasisApprovals':['frozen-action'],
  'partialApprovalActionAuditCommits':['atomic-decision'],'validFormalDecisions':['atomic-decision','typed-command'],
  'approvalBasisOrVersionMismatches':['frozen-action']},
 'native-roundtrip-types': {
  'requiredTypesAbsentWithoutBlocker':['native-roundtrip','legal-roundtrip'],
  'canonicalRoundtripByteMismatches':['native-roundtrip','legal-roundtrip'],
  'legalRootFalseRejections':['legal-root','legal-roundtrip'],'cursorOrParentMismatches':['legal-root','native-roundtrip','legal-roundtrip']},
 'native-reference-order': {
  'crossSessionTypedReferencesAccepted':['references','invalid-history'],'invalidOrderRestores':['tree-and-order','invalid-history'],
  'corruptHistoryRequests':['references','tree-and-order','invalid-history'],
  'corruptionEvidenceDeleted':['references','tree-and-order','invalid-history'],
  'validSequenceRestores':['tree-and-order','invalid-history']},
 'session-input-delivery': {
  'ownershipMismatchNativeDeliveries':['ownership'],'unknownDeliveryAutomaticResends':['delivery-state'],
  'unknownDeliveryState':['delivery-state'],'validInputDeliveries':['ownership','delivery-state'],
  'admissionMisreportedAsConsumption':['delivery-state']},
 'session-identity-pagination': {
  'duplicatePiIdentityCommits':['identity','identity-initialization'],
  'wrongNativeEventsAccepted':['identity','identity-initialization'],
  'gappedSequenceRestores':['pagination'],'validRestoredEntryCount':['pagination'],
  'validEventJoinMismatches':['identity','identity-initialization']},
}


def _requirements_for(slug, field, requirements):
    if slug not in FIELD_REQUIREMENTS:
        return requirements
    suffixes=FIELD_REQUIREMENTS[slug][field]
    return [r for r in requirements if r.rsplit('/',1)[-1] in suffixes]


def additions():
    suites={}
    for slug,module,stage,requirements,facts,procedure,expected in MATRICES:
        identity='contract-supplement-'+slug
        commands=[{'id':'prepare','actor':'trusted_fixture_adapter','command':'prepare_isolated_fixture',
                   'arguments':{'facts':deepcopy(facts),'nativeHistory':'Actual SDK operations; fixture facts are not observations.'}},
                  {'id':'exercise','actor':'trusted_product_adapter','command':'execute_contract_matrix','after':['prepare'],
                   'arguments':{'procedure':procedure,'reset':'Fresh equivalent fixture for each variant; preserve state within fault recovery.'}},
                  {'id':'collect','actor':'independent_evidence_collector','command':'collect_contract_observations','after':['exercise'],
                   'arguments':{'fields':list(expected),'sources':['raw_command_receipts','canonical_bytes','sqlite_before_after','complete_native_trace','target_ledger'],
                                'missing':'Unknown, not zero; join all relevant jobs, attempts and identities.'}}]
        checks=[]
        for field,value in expected.items():
            checks.append({'checkId':identity+':'+field,'capabilities':[],'harnessModules':[module],
                'requirementRefs':_requirements_for(slug,field,requirements),'evaluationMode':'F','criterion':procedure+'; independently measure '+field,
                'assertion':{'path':'observation.'+field,'op':'eq','value':value},
                'evidenceRequirements':[{'kind':k,'required':True} for k in ('trusted_fixture_receipt','actual_product_command_receipt','complete_independent_readback')],
                'required':True,'hardConstraint':True,'preconditions':[
                    {'path':'observation.matrix-reached','op':'eq','value':True,'description':'Every named mutation/control and fault boundary was actually reached and captured; disabled policy mode is BLOCKED.', 'evidence':['trusted_fixture_receipt','actual_product_command_receipt']} ]})
        scenario={'id':identity,'title':slug,'setup':{'protocol':'coverage_episode','initialState':deepcopy(facts),
            'commands':commands,'faults':[{'window':procedure,'receiptRequired':True}],'businessRef':None,'businessPatches':[]},
            'exercise':{'input':{'request':procedure},'commands':deepcopy(commands)},'oracle':{'graderRef':'declared-observations','checks':checks},
            'traceability':{'modRefs':[],'rtRefs':[],'rtcRefs':[],'sourceRefs':[],'legacyIds':[],'harnessModules':[module]},
            'applicability':{'minimumStage':stage,'adapterRef':None,'executionEligibility':'blocked',
                'blockers':['product_adapter_required','trusted_collector_required','content_review_required']+(['approved_multi_slot_mode_required'] if slug=='delegation-slots' else [])},
            'split':'development','leakageGroup':identity,'controlRefs':[]}
        suite=suites.setdefault(module,{'schemaVersion':1,'kind':'product_contract','id':'supplement-'+module,'version':1,'harnessModule':module,'scenarios':[]})
        suite['scenarios'].append(scenario)
    return list(suites.values())


def condition_checks():
    mappings={}
    for suite in additions():
        for s in suite['scenarios']:
            for c in s['oracle']['checks']:
                for r in c['requirementRefs']:mappings.setdefault(r,[]).append({'assetId':s['id'],'checkId':c['checkId']})
    return mappings


BENCHMARKS = {
 'private-work-roots':['BM-08','BM-09'], 'private-agent-directory':['BM-08','BM-09'],
 'action-identity':['BM-05','BM-07'], 'attempt-transition':['BM-05','BM-07'],
 'safe-retry-controls':['BM-05','BM-07'], 'assessment-basis':['BM-02'],
 'delegation-slots':['BM-12'], 'context-publication':['BM-07','BM-11'],
 'context-recovery':['BM-07','BM-11'], 'approval-atomic-typed':['BM-04','BM-08'],
 'evidence-reapproval':['BM-04','BM-05'], 'human-adoption-transaction':['BM-04'],
 'dataset-restore-identity':['BM-07','BM-09'], 'native-roundtrip-types':['BM-07','BM-11'],
 'native-reference-order':['BM-07','BM-11'], 'persistence-abort':['BM-07','BM-11'],
 'session-input-delivery':['BM-07','BM-11'], 'session-identity-pagination':['BM-07','BM-11'],
}


def benchmark_checks(asset, check):
    aid=asset['id']
    if aid.startswith('contract-supplement-'):
        return BENCHMARKS[aid.removeprefix('contract-supplement-')]
    selected={
        **{'contract-coverage-manifest-'+v:['BM-09','BM-11'] for v in ('missing','digest','owner','valid')},
        **{'contract-coverage-history-'+v:['BM-07','BM-11'] for v in ('hash','columns','valid')},
        **{'contract-coverage-title-'+v:['BM-07','BM-11'] for v in ('commit','failure')},
    }
    return selected.get(aid,[])
