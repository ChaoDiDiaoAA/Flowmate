"""Supplemental Harness cases: specifications, never manufactured run evidence.

Commands below are declarative adapter operations, not claimed product APIs.
Native history is created/captured by the locked real Pi adapter; no synthetic
header, entries, stream, history or tool output is supplied as an execution.
Only ``input`` is model-visible. Expectations never enter adapter projections.
"""
from copy import deepcopy


MODULES = ('foundation', 'agent-runtime', 'tools', 'events', 'sessions',
           'context', 'memory', 'compaction', 'workflow', 'prompt-skills',
           'extensions', 'subagents', 'actions', 'operations', 'eval-infrastructure')
CATEGORIES = ('extraction', 'matching', 'approval', 'submission', 'runtime',
              'isolation', 'platform')
SCENARIOS = []

# Exact, unique normative row prefixes in the evaluation specification.
GROUPS = {
 'manifest': ('foundation', 'P1', 'platform', '3.24', '| 文件清单与运行绑定 |', ['MOD-01','MOD-25','MOD-27','RT-01'], 'execution_manifest', '读取当前获准任务配置，列出本次可用的只读能力。'),
 'dataset': ('foundation', 'P0', 'platform', '3.24', '| 输入与数据集 |', ['MOD-09','MOD-25','MOD-29'], 'immutable_input_manifest', '读取这份合成文档并报告文档编号。'),
 'session': ('sessions', 'P4', 'runtime', '3.24', '| Session生命周期与恢复 |', ['MOD-08','MOD-25','MOD-29','RT-05'], 'sqlite_native_session', '记住项目代号青竹，下一轮回答项目代号。'),
 'memory': ('memory', 'P4', 'runtime', '3.24', '| 原生Memory与Compaction |', ['MOD-03','MOD-08','MOD-25','RT-06'], 'native_entry_persistence', '读取合成任务中当前有效的收件城市。'),
 'context': ('context', 'P5', 'runtime', '3.24', '| 上下文快照独立存储 |', ['MOD-03','MOD-05','MOD-08','MOD-25','MOD-29'], 'context_snapshot', '查询合成供应商的当前登记地址并保存候选。'),
 'binding': ('sessions', 'P4', 'runtime', '3.24', '| 持久提交与活动绑定 |', ['MOD-08','MOD-25','MOD-26','MOD-28','RT-05'], 'native_commit_boundary', '记住本轮订单代号，然后继续下一轮查询。'),
 'delegation': ('subagents', 'P11', 'runtime', '3.24', '| 父子委派 |', ['MOD-34','MOD-08','MOD-25','MOD-28','RT-17'], 'native_agent_tool', '请委派获准的只读助手分别核对合成资料中的供应商和订单。'),
 'assessment': ('workflow', 'P8', 'matching', '3.24', '| 候选、修订与校验依据 |', ['MOD-11','MOD-12','MOD-15','MOD-16','MOD-17','MOD-19','MOD-25'], 'assessment_snapshot', '核对合成发票 SIM-INV-01 的供应商和订单。'),
 'input': ('sessions', 'P4', 'runtime', '3.24', '| 会话输入受理 |', ['MOD-07','MOD-08','MOD-25','RT-11','RT-12'], 'session_input_delivery', '把当前任务收件城市更新为苏州。'),
 'interaction': ('workflow', 'P8', 'approval', '3.24', '| 人工业务交互 |', ['MOD-07','MOD-17','MOD-23','MOD-25'], 'human_business_interaction', '合成发票的订单号不清楚，请向操作员确认。'),
 'approval': ('actions', 'P12', 'approval', '3.24', '| 正式提交审批 |', ['MOD-19','MOD-21','MOD-23','MOD-25','MOD-26'], 'frozen_action_approval', '为合成发票生成预览，等待操作员提交确认。'),
 'dispatch': ('actions', 'P12', 'submission', '3.24', '| 提交动作派发与恢复 |', ['MOD-18','MOD-19','MOD-21','MOD-25','MOD-26','MOD-28'], 'logical_action_dispatch', '将已确认的合成发票提交到本地测试目标并查询结果。'),
 'prompt': ('prompt-skills', 'P1', 'runtime', '3.2', '| MOD-04 Prompt 与任务决策 |', ['MOD-04'], 'live_model_decisions', '根据提供的合成资料完成当前任务。'),
 'payload': ('actions', 'P12', 'submission', '3.3', '| MOD-18 提交预览与载荷构建 |', ['MOD-18'], 'frozen_payload', '为合成发票生成目标系统提交预览。'),
 'browser': ('actions', 'P12', 'submission', '3.3', '| MOD-20 Browser / 07B2B 录入 |', ['MOD-20'], 'local_browser_target', '在本地测试页面录入合成发票。'),
 'credentials': ('operations', 'P2', 'isolation', '3.4', '| MOD-24 Adapter Registry / 环境 / 凭证 |', ['MOD-24'], 'environment_adapter_binding', '通过获准的只读资料工具查询合成供应商。'),
 'release': ('operations', 'P13', 'platform', '3.4', '| MOD-27 版本 / Release / 发布门禁 |', ['MOD-27'], 'release_gate', '读取本次运行已批准的能力和配置。'),
 'trial': ('eval-infrastructure', 'P1', 'platform', '3.5', '| MOD-31 EvalRunner / Trial 调度 |', ['MOD-31'], 'trial_scheduler', '读取合成资料中的项目代号。'),
}


def _check(path, value, description, op='eq'):
    return {'path': 'observation.' + path, 'op': op,
            'value': deepcopy(value), 'description': description}


def _add(group, slug, title, state, commands, assertions, *, variant='normal',
         control=None, faults=(), phase=None, mode='F', module=None,
         section=None, anchor=None, enabled=None, input=None, refs=()):
    mod, first, category, source, source_anchor, base_refs, capability, task = GROUPS[group]
    sid = group + '-' + slug
    native = group in {'session', 'memory', 'binding', 'delegation'}
    item = {
        'id': sid, 'module': module or mod, 'title': title,
        'phase': phase or first, 'category': category, 'mode': mode,
        'sourceSection': section or source, 'sourceAnchor': anchor or source_anchor,
        'refs': list(dict.fromkeys(base_refs + list(refs))),
        'trigger': title + '；按声明的时序执行正式入口并采集真实前后证据。',
        'input': deepcopy(input if input is not None else {
            'task': task, 'documents': [{'id': 'SIM-DOC-01',
                'text': '合成资料：项目青竹；发票 SIM-INV-01；供应商 SIM-SUP-01；订单 SIM-PO-01；收件城市苏州。'}]}),
        'initialState': {'fixtureOrigin': 'synthetic_test_setup',
                         'workspace': 'SIM-WS-A', 'conditions': deepcopy(state)},
        'commands': [{'operation': op, 'parameters': deepcopy(params)} for op, params in commands],
        'faults': deepcopy(list(faults)),
        'expected': [_check(*a) for a in assertions],
        'evidence': ['正式命令请求及返回身份', '事务提交前后数据库行与约束结果',
                     '可信调用关联与版本记录',
                     '适配器完整模型请求及工具执行账本（含故障屏障前后）',
                     '原生适配器实际采集的header/entries/当前位置' if native else '输入文件或状态快照摘要'],
        'forbidden': ['把夹具准备当成实际执行通过', '将评分断言或期望值提供给被测模型',
                      '评测设施代替产品补做业务动作'],
        'normalControlId': control, 'variant': variant,
        'requiredCapability': capability,
        'enabledMode': {'required': list(enabled or [capability]),
                        'disabledDisposition': 'NOT_RUN_with_capability_restriction',
                        'countsAsExecutedWhenDisabled': False},
        'adapterRequirements': {'status': 'pending_product_harness_adapter',
            'commandSemantics': 'declarative_operations_not_product_api',
            'executionStatus': 'NOT_RUN', 'nativeEvidenceRequired': native,
            'nativeFixtureSource': 'real_locked_pi_0.85.1_adapter' if native else None,
            'syntheticNativeHistoryAllowed': False},
        'requirementKeys': [group + '.' + slug],
    }
    if group in {'dispatch', 'browser', 'payload', 'approval'}:
        item['evidence'].append('独立本地目标业务记录、请求身份及回执')
    if native:
        item['initialState']['nativeSetup'] = {
            'method': 'create_and_capture_via_real_product_adapter',
            'fixtureStatus': 'pending_capture', 'persistedEntriesProvided': False}
    participants = {
        'binding':['memory','events'], 'delegation':['tools','sessions'],
        'approval':['workflow'], 'dispatch':['operations'],
    }
    item['relatedModules'] = participants.get(group, [])
    if sid in {'context-sqlite-only-restore','memory-compaction-authority'}:
        item['relatedModules'] = ['sessions','memory'] if group=='context' else ['workflow','actions']
    SCENARIOS.append(item)


# 1. Immutable manifests, verified loading, historical pinning and controls.
_add('manifest', 'verified-load', '获准清单核验后固定运行快照',
     {'manifestVersion': 1, 'workspaceStatus': 'active'},
     [('index_manifest', {'version': 1}), ('create_job', {}), ('start_run', {})],
     [('manifest.jobVersion', 1, 'Job固定版本'), ('runtime.requestsBeforeReady', 0, '核验前没有请求'),
      ('runtime.snapshotManifestVersion', 1, '实际装载与清单一致')])
for slug, field, value, reason in [
 ('hash-mismatch', 'mutateFileAfterIndex', True, 'hash_mismatch'),
 ('missing-file', 'removeIndexedFile', True, 'file_missing'),
 ('wrong-workspace', 'manifestWorkspace', 'SIM-WS-B', 'workspace_mismatch')]:
    _add('manifest', slug, '拒绝装载清单：' + reason, {field: value},
         [('index_manifest', {}), ('apply_fixture_mutation', {'field': field}), ('start_run', {})],
         [('manifest.rejectionReason', reason, '拒绝原因明确'), ('runtime.modelRequests', 0, '没有模型执行'),
          ('runtime.toolExecutions', 0, '没有工具执行')], variant='permission', control='manifest-verified-load')
_add('manifest', 'historical-pin', '替换清单后旧Job与Run保持原组合', {'manifestVersion': 1},
     [('create_job', {'alias': 'old'}), ('start_run', {'job': 'old'}),
      ('publish_manifest', {'version': 2}), ('create_job', {'alias': 'new'})],
     [('manifest.oldJobVersion', 1, '历史Job保持原版本'), ('runtime.oldSnapshotVersion', 1, '历史快照不漂移'),
      ('manifest.newJobVersion', 2, '新Job使用新候选')], variant='boundary')
_add('manifest', 'revoked-control', '旧清单受当前环境撤销控制约束', {'manifestVersion': 1},
     [('revoke_manifest', {'environment': 'local-test', 'scope': 'SIM-WS-A'}), ('start_run', {'version': 1})],
     [('runtime.modelRequests', 0, '撤销后不可开始模型请求'), ('release.admission', 'revoked', '依据当前控制拒绝')],
     variant='permission', control='manifest-verified-load', phase='P13')

# 2. Inputs remain externally parsed, paired, and immutable across restart.
_add('dataset', 'paired-input', '外部解析与原票按不可变清单配对', {'inputCount': 1, 'externalParsedCount': 1},
     [('index_documents', {}), ('load_dataset_manifest', {}), ('resolve_input_pair', {})],
     [('dataset.resolvedPairs', 1, '找到唯一原票解析配对'), ('dataset.productParserTasks', 0, '不启动产品Parser'),
      ('dataset.manifestHashMatches', True, '输入清单摘要一致')])
for slug, mutation, reason in [('missing-source', 'delete_source', 'source_missing'),
                              ('replaced-parse', 'replace_parse', 'digest_mismatch'),
                              ('foreign-pair', 'foreign_workspace_pair', 'workspace_mismatch')]:
    _add('dataset', slug, '重启后拒绝失效输入配对：' + reason, {'datasetVersion': 1},
         [('index_documents', {}), ('mutate_input_fixture', {'kind': mutation}), ('restart_and_resolve_inputs', {})],
         [('dataset.rejectionReason', reason, '输入身份重新核验'), ('dataset.staleIdentityUses', 0, '不沿用旧输入身份')],
         variant='fault', control='dataset-paired-input', phase='P2')
_add('dataset', 'backup-pairing', '备份恢复重核输入版本与归属', {'datasetVersion': 2},
     [('backup_instance', {}), ('restore_test_copy', {}), ('verify_all_input_references', {})],
     [('dataset.restoredVersion', 2, '恢复使用同版输入清单'), ('dataset.verifiedPairs', 1, '文件配对重新验真'),
      ('dataset.crossWorkspacePairs', 0, '不存在跨空间配对')], variant='recovery', phase='P13')

# 3. Native identity, atomic initialization, complete paginated restoration.
_add('session', 'complete-restore', 'SQLite完整历史分页恢复并恢复当前位置',
     {'captureTurns': 7, 'readPageSize': 2, 'nativeSessionFilesEnabled': False},
     [('create_native_session', {}), ('run_real_turns_and_capture', {'count': 7}),
      ('move_native_cursor', {'target': 'captured_prior_entry'}), ('close_run_and_clear_temp', {}),
      ('restore_from_sqlite', {'iterateAllPages': True})],
     [('session.restoredEntryCountEqualsCommitted', True, '遍历全部页恢复全部条目'),
      ('session.sequenceGaps', 0, 'sequence连续'), ('session.cursorEqualsCommitted', True, '恢复当前位置'),
      ('session.nativeFilesRead', 0, 'JSONL不参与恢复'), ('session.productNativeMappingCount', 1, '产品与Pi身份唯一映射')])
for slug, fault, reason in [('pi-id-mismatch', 'header_id_conflict', 'native_identity_mismatch'),
                           ('format-mismatch', 'header_format_conflict', 'native_format_mismatch'),
                           ('duplicate-pi-id', 'reuse_pi_id_for_second_product_session', 'pi_identity_not_unique'),
                           ('wrong-event-session', 'event_identity_unknown', 'native_identity_unmapped')]:
    _add('session', slug, '原生会话身份校验：' + reason, {'captureSessionCount': 2},
         [('create_native_session', {}), ('inject_captured_identity_fault', {'kind': fault}), ('open_native_session', {})],
         [('session.rejectionReason', reason, '明确拒绝错误映射'), ('session.partialCommits', 0, '无部分提交'),
          ('runtime.requestsOnRejectedSession', 0, '拒绝会话不可执行')], variant='fault', control='session-complete-restore')
_add('session', 'initialization-failure', '初始化条目写入失败不发布活动会话', {'captureInitialEntries': True},
     [('begin_native_initialization', {}), ('commit_session_initialization', {})],
     [('session.publishedActiveCount', 0, '初始化失败不发布active'), ('session.partialCommits', 0, 'header与条目原子提交'),
      ('runtime.modelRequests', 0, '成功之前没有执行')], variant='fault', control='session-complete-restore',
     faults=[{'at': 'before_initialization_commit', 'inject': 'database_write_failure'}])
_add('session', 'separate-version-cas', '产品元数据与历史版本各自进行并发控制',
     {'metadataVersion': 3, 'storageVersion': 8},
     [('update_product_metadata', {'expectedVersion': 3}), ('append_native_entry', {'expectedStorageVersion': 8})],
     [('session.metadataVersion', 4, '元数据版本独立推进'), ('session.storageVersion', 9, '历史版本独立推进')], variant='boundary')
_add('session', 'inmemory-only', 'P1内存会话不声称具有持久恢复', {'persistenceEnabled': False},
     [('create_inmemory_session', {}), ('close_run', {}), ('request_restart_resume', {})],
     [('session.persistentRestores', 0, '未实现持久恢复不报成功'), ('session.resumeDisposition', 'unsupported', '明确报告能力边界')],
     variant='boundary', phase='P1', enabled=['inmemory_session'])

# 4. Validate captured native entries; fault injection mutates genuine captures.
_add('memory', 'legal-native-roundtrip', '完整原生类型与普通扩展字符串无损恢复',
     {'captureTypes': ['message','tool','model','label','extension','custom'],
      'customPayload': {'displayText': 'root/entry-looking-string', 'referenceDeclaration': None}},
     [('capture_native_entry_types', {}), ('persist_captured_batch', {}), ('restore_native_history', {})],
     [('memory.roundtripMismatchCount', 0, '逐类原貌无损'), ('memory.arbitraryStringsTreatedAsRefs', 0, '普通字符串不当历史引用'),
      ('memory.toolAssociationsMismatchCount', 0, '工具调用关联保留')])
_add('memory', 'same-content-idempotent', '同原生ID同规范化正文重复写幂等', {'repeatCapturedEntry': 2},
     [('capture_native_entry', {}), ('persist_captured_entry', {}), ('persist_captured_entry', {})],
     [('memory.insertedRows', 1, '相同条目只写一次'), ('memory.hashRecomputed', True, '使用规范化正文重算摘要')], variant='boundary')
for slug, kind, reason in [
 ('tampered-body-old-hash', 'change_body_keep_hash', 'entry_hash_mismatch'),
 ('type-column-conflict', 'change_type_column', 'entry_type_mismatch'),
 ('id-column-conflict', 'change_id_column', 'entry_id_mismatch'),
 ('parent-column-conflict', 'change_parent_column', 'entry_parent_mismatch'),
 ('same-id-new-content', 'change_body_same_id_recompute_hash', 'native_id_content_conflict'),
 ('cycle', 'cycle_parent_chain', 'parent_cycle'),
 ('sequence-conflict', 'duplicate_sequence', 'sequence_conflict'),
 ('illegal-order', 'parent_after_child', 'illegal_sequence_order'),
 ('dangling-parent', 'missing_parent', 'dangling_parent'),
 ('dangling-label', 'missing_label_target', 'dangling_label_target'),
 ('dangling-custom-ref', 'missing_declared_custom_reference', 'dangling_custom_reference'),
 ('cross-session-ref', 'other_session_parent', 'cross_session_reference'),
 ('dangling-cursor', 'missing_current_entry', 'dangling_cursor')]:
    _add('memory', slug, '拒绝非法原生历史：' + reason, {'captureValidBatchBeforeMutation': True},
         [('capture_native_entry_types', {}), ('mutate_captured_batch', {'kind': kind}), ('persist_captured_batch', {})],
         [('memory.rejectionReason', reason, '非法历史有明确原因'), ('memory.partialInsertedRows', 0, '整批拒绝无部分接受')],
         variant='fault', control='memory-legal-native-roundtrip')
_add('memory', 'null-root', '合法空根parent与空当前位置可保存', {'nativeTree': 'empty'},
     [('create_native_session', {}), ('persist_captured_native_root', {}), ('restore_native_history', {})],
     [('memory.rootParent', None, '原生空根允许null'), ('session.currentEntryId', None, '空历史允许空当前位置'),
      ('session.restoreStatus', 'restored', '合法空根恢复成功')], variant='boundary')
_add('memory', 'branch-root-sentinel', 'Pi空leaf分支摘要root哨兵合法', {'nativeFormat': '0.85.1', 'branchFrom': 'empty_leaf'},
     [('create_native_session', {}), ('generate_native_branch_summary', {'from': 'empty_leaf'}),
      ('persist_captured_batch', {}), ('restore_native_history', {})],
     [('memory.branchSummaryFromId', 'root', '保留原生root哨兵'), ('memory.danglingReferenceRejections', 0, '不把root哨兵误当悬空引用')],
     variant='boundary', phase='P7', module='compaction', enabled=['native_branch_summary'])
for slug, kind, reason in [('dangling-compaction', 'missing_first_kept_entry', 'dangling_first_kept_entry'),
                           ('dangling-branch-summary', 'missing_from_entry', 'dangling_branch_from')]:
    _add('memory', slug, '摘要条目拒绝悬空引用：' + reason, {'captureNativeSummaries': True},
         [('generate_native_summaries', {}), ('mutate_captured_batch', {'kind': kind}), ('persist_captured_batch', {})],
         [('memory.rejectionReason', reason, '摘要引用必须有效'), ('memory.partialInsertedRows', 0, '批量写入原子拒绝')],
         variant='fault', control='memory-branch-root-sentinel', phase='P7', module='compaction', enabled=['native_compaction','native_branch_summary'])
_add('memory', 'compaction-authority', '恢复压缩历史不复活已失效动作确认', {'approvedRevision': 1, 'currentRevision': 2},
     [('capture_real_compaction', {}), ('restore_native_history', {}), ('request_action_admission', {})],
     [('approval.admission', 'stale_basis', '当前Revision控制业务准入'), ('external.businessEffects', 0, '旧摘要不产生授权')],
     variant='permission', control='approval-valid-frozen', phase='P12', module='compaction', enabled=['native_compaction','frozen_action_approval'])

# 5. Trusted request association, immutable snapshots, transactional publication.
_add('context', 'normal-request', '快照与实际请求工具候选形成可信关联', {'snapshotAlias': 'A', 'currentGeneration': 1},
     [('build_and_commit_context', {'alias': 'A'}), ('deliver_model_input', {'context': 'A'}),
      ('call_read_tool', {}), ('save_candidate', {})],
     [('context.toolSnapshotAlias', 'A', '工具关联实际交付的A'), ('context.candidateSnapshotAlias', 'A', '候选固定实际context_ref'),
      ('context.bodyHashVerified', True, '快照正文摘要一致')])
_add('context', 'late-tool-after-switch', '请求A的工具迟到时Run已切B仍关联A', {'snapshotAliases': ['A','B']},
     [('build_and_commit_context', {'alias': 'A'}), ('deliver_model_input', {'context': 'A'}),
      ('start_read_tool_with_barrier', {}), ('build_and_commit_context', {'alias': 'B'}),
      ('release_tool_barrier', {}), ('save_candidate', {})],
     [('context.runCurrentAlias', 'B', 'Run当前指针更新'), ('context.toolSnapshotAlias', 'A', '迟到工具仍关联原请求'),
      ('context.candidateSnapshotAlias', 'A', '候选沿实际请求关联')], variant='boundary')
for slug, kind, reason in [
 ('model-forged-id', 'model_supplied_snapshot', 'untrusted_snapshot_identity'),
 ('cross-run', 'other_run_snapshot', 'run_mismatch'),
 ('cross-workspace', 'other_workspace_snapshot', 'workspace_mismatch'),
 ('cross-job', 'other_job_snapshot', 'job_mismatch'),
 ('dangling-history', 'missing_history_reference', 'dangling_history_reference'),
 ('body-tamper', 'change_body_keep_hash', 'snapshot_hash_mismatch'),
 ('stale-basis', 'prior_input_version', 'basis_version_mismatch'),
 ('same-id-changed', 'same_id_different_body', 'snapshot_identity_conflict')]:
    _add('context', slug, '拒绝错误快照关联：' + reason, {'captureValidContext': True},
         [('build_and_commit_context', {'alias': 'A'}), ('inject_context_fault', {'kind': kind}), ('deliver_model_input', {})],
         [('context.rejectionReason', reason, '错关联明确拒绝'), ('context.invalidPublications', 0, '不发布非法投影')],
         variant='permission', control='context-normal-request')
_add('context', 'commit-failure', '快照事务失败不移动指针不发布输入', {'currentSnapshotAlias': 'A'},
     [('build_and_commit_context', {'alias': 'B'})],
     [('context.runCurrentAlias', 'A', '事务失败保留原指针'), ('context.publishedAliasBCount', 0, '失败快照没有输入交付'),
      ('context.partialCommits', 0, '快照与Run指针一起回滚')], variant='fault', control='context-normal-request',
     faults=[{'at': 'between_context_insert_and_run_pointer', 'inject': 'database_write_failure'}])
_add('context', 'same-content-idempotent', '相同快照重复保存不重复推进sequence', {'repeatCount': 2},
     [('build_context', {'alias': 'A'}), ('commit_context', {'alias': 'A'}), ('commit_context', {'alias': 'A'})],
     [('context.insertedSnapshotCount', 1, '相同内容只存一次'), ('context.sequenceDuplicates', 0, 'Run内sequence唯一')], variant='boundary')
_add('context', 'runtime-snapshot-fixed', '多轮Context更新不改RuntimeSnapshot且无循环摘要', {'runtimeInitialContext': 'A'},
     [('build_and_commit_context', {'alias': 'A'}), ('freeze_runtime_snapshot', {}),
      ('build_and_commit_context', {'alias': 'B'}), ('query_snapshot_hash_dependencies', {})],
     [('runtime.snapshotContextAlias', 'A', 'RuntimeSnapshot只固定生成时的A'),
      ('runtime.snapshotDigestChanged', False, '历史RuntimeSnapshot不重写'), ('context.hashDependencyCycles', 0, 'Context不反向依赖RuntimeSnapshot摘要')], variant='boundary')
_add('context', 'sqlite-only-restore', '无导出文件恢复Context并保留历史调用关联', {'exportFilesPresent': False},
     [('build_and_commit_context', {'alias': 'A'}), ('deliver_model_input', {}), ('call_read_tool', {}),
      ('backup_instance', {}), ('restore_test_copy', {}), ('query_historical_context_associations', {})],
     [('context.restoredSnapshotAlias', 'A', '从数据库恢复完整快照'), ('context.historicalAssociationChanges', 0, '恢复不改写历史关联'),
      ('context.exportFilesRead', 0, '导出文件不参与恢复')], variant='recovery', phase='P13')
_add('context', 'pre-p5-null', '未启用ContextSnapshot阶段保留真实空引用', {'contextSnapshotsEnabled': False},
     [('start_run', {}), ('call_read_tool', {})],
     [('context.toolSnapshotId', None, 'P2无快照时使用真实空引用'), ('context.fabricatedHistoricalSnapshots', 0, '不补造历史')],
     variant='boundary', phase='P2', enabled=['readonly_tools'])

# 6. Commit boundaries encompass synchronous native mutations, not async loops.
_add('binding', 'synchronous-commit', '最外层同步历史变更返回即提交完整状态', {'nativeMutations': 'nested_sync'},
     [('create_native_session', {}), ('invoke_native_public_mutation', {'nested': True}), ('inspect_committed_state', {})],
     [('binding.outerCallCommitCount', 1, '同步嵌套合并一次事务'), ('binding.pendingAfterReturn', 0, '返回时没有未保存历史'),
      ('binding.headerCursorEntriesConsistent', True, 'header条目指针一致')])
_add('binding', 'mid-loop-durable', '异步Loop尚未结束已完成原生变更必须落库', {'holdLoopAfterFirstEntry': True},
     [('begin_real_prompt', {}), ('hold_after_public_history_mutation', {}), ('read_sqlite_from_independent_connection', {}), ('release_loop', {})],
     [('binding.committedEntriesBeforeLoopEnd', 1, 'Loop结束前已有持久条目', 'gte'),
      ('binding.listenerOnlyPersistence', False, '提交不只依赖事件监听')], variant='boundary')
_add('binding', 'cursor-version', '只移动当前位置仍推进历史版本', {'storageVersion': 4},
     [('capture_native_branch', {}), ('move_native_cursor', {'expectedStorageVersion': 4})],
     [('session.storageVersion', 5, '纯指针更新有版本提交'), ('binding.cursorEqualsNative', True, '当前位置与原生一致')], variant='boundary')
_add('binding', 'cursor-cas-conflict', '并发移动指针冲突不覆盖当前分支', {'storageVersion': 4},
     [('move_native_cursor', {'target': 'branch-A', 'expectedStorageVersion': 4}),
      ('move_native_cursor', {'target': 'branch-B', 'expectedStorageVersion': 4})],
     [('binding.conflictedCursorWrites', 1, '旧storage_version明确冲突'), ('session.currentBranch', 'branch-A', '失败命令不改当前位置')],
     variant='fault', control='binding-cursor-version')
_add('binding', 'title-atomic', '标题变更及原生session_info在同事务提交', {'productTitle': '原题'},
     [('update_session_title', {'title': '新题'})],
     [('session.productTitle', '新题', '产品标题更新'), ('session.nativeTitle', '新题', '原生信息同步更新'),
      ('binding.titleTransactionCount', 1, '标题与原生条目同事务')])
_add('binding', 'title-interrupted', '标题同步中断回滚并poison活动绑定', {'productTitle': '原题'},
     [('update_session_title', {'title': '新题'}), ('attempt_new_read_tool', {})],
     [('session.productTitle', '原题', '产品标题回滚'), ('binding.partialCommits', 0, '原生标题无部分提交'),
      ('binding.state', 'poisoned', '保存失败绑定poisoned'), ('runtime.toolsAfterSaveFailure', 0, '新工具阻断'),
      ('runtime.abortRequests', 1, '请求中止')], variant='fault', control='binding-title-atomic',
     faults=[{'at': 'after_native_session_info_before_commit', 'inject': 'database_write_failure'}])
_add('binding', 'stale-binding', '迟到旧绑定写历史被拒绝', {'currentGeneration': 2, 'eventGeneration': 1},
     [('capture_native_entry', {}), ('persist_from_retired_binding', {})],
     [('binding.rejectionReason', 'stale_binding', '旧binding无保存权限'), ('binding.partialCommits', 0, '旧结果不推进历史')],
     variant='permission', control='binding-synchronous-commit')
_add('binding', 'last-committed-recovery', '保存失败重启从最后提交点恢复且不重放未知动作', {'interruptAfterToolStarted': True},
     [('begin_real_prompt', {}), ('capture_committed_checkpoint', {}), ('crash_before_next_history_commit', {}), ('restore_from_sqlite', {})],
     [('session.restoredCheckpointEqualsCommitted', True, '恢复最后已提交状态'), ('runtime.automaticUnknownToolReplays', 0, '未知工具不自动重放'),
      ('runtime.automaticModelReplays', 0, '未知请求不自动重放')], variant='recovery')

# 7. A slot belongs to one real LLM Agent tool call; Eval never spawns children.
_add('delegation', 'single-real-child', '真实Agent工具先登记pending再绑定子会话', {'enabledChildModes': ['single']},
     [('run_parent_until_real_agent_tool', {}), ('observe_pending_before_plugin_start', {}), ('await_plugin_identity', {})],
     [('delegation.pendingBeforePluginStart', True, '启动前已有pending身份'), ('delegation.childRuns', 1, '一个真实子Run'),
      ('delegation.trustedIdentityMappings', 1, '插件和Session准确关联'), ('delegation.evalSpawnCalls', 0, 'Eval不主动委派')])
_add('delegation', 'multiple-slots', '同工具调用两个合法槽位分别登记', {'enabledChildModes': ['parallel'], 'requestedSlots': ['supplier','order']},
     [('run_parent_until_real_agent_tool', {}), ('await_multiple_plugin_children', {})],
     [('delegation.childRuns', 2, '不同槽位不是重复执行'), ('delegation.distinctSlots', 2, '槽位独立'),
      ('delegation.originToolCallCount', 1, '同一次来源工具调用')], variant='boundary', enabled=['native_agent_tool','parallel_children'])
_add('delegation', 'same-slot-repeat', '相同来源工具与槽位重复登记幂等', {'repeatAdmissionCount': 2},
     [('run_parent_until_real_agent_tool', {}), ('redeliver_same_admission', {})],
     [('delegation.childRuns', 1, '同槽位不创建第二个Run'), ('delegation.pluginStarts', 1, '没有第二次真实委派')],
     variant='boundary', control='delegation-single-real-child')
_add('delegation', 'out-of-order-identities', '插件身份乱序按明确槽位绑定', {'enabledChildModes': ['parallel'], 'identityReturnOrder': ['order','supplier']},
     [('run_parent_until_real_agent_tool', {}), ('release_identity_barrier', {'slot': 'order'}), ('release_identity_barrier', {'slot': 'supplier'})],
     [('delegation.mappingMismatches', 0, '插件与Session不按最近记录猜测'), ('delegation.trustedIdentityMappings', 2, '两个槽位准确补齐')],
     variant='boundary', enabled=['native_agent_tool','parallel_children'])
_add('delegation', 'partial-start-failure', '多子启动部分失败保留原pending和失败身份', {'enabledChildModes': ['parallel'], 'failSlot': 'order'},
     [('run_parent_until_real_agent_tool', {}), ('await_children', {})],
     [('delegation.childRuns', 2, '失败子Run仍可查'), ('delegation.failedChildren', 1, '失败独立记录'),
      ('delegation.successfulChildren', 1, '其他合法子任务不丢失'), ('delegation.replacementRuns', 0, '不另造委派替代失败身份')],
     variant='fault', control='delegation-multiple-slots', enabled=['native_agent_tool','parallel_children'],
     faults=[{'at': 'plugin_start:order', 'inject': 'startup_failure'}])
_add('delegation', 'pending-crash', 'pending登记后Host崩溃恢复不补发', {'crashPoint': 'after_pending_before_plugin_identity'},
     [('run_parent_until_real_agent_tool', {}), ('crash_host_at_barrier', {}), ('restore_parent_records', {})],
     [('delegation.originalPendingPreserved', True, '保留原pending身份'), ('delegation.evalSpawnCalls', 0, '恢复不主动补发'),
      ('delegation.guessedIdentityBindings', 0, '缺失身份不猜补')], variant='recovery', phase='P13')
_add('delegation', 'late-after-cancel', '父取消后的迟到子结果不能重获执行权', {'enabledChildModes': ['single']},
     [('run_parent_until_real_agent_tool', {}), ('cancel_parent', {}), ('release_child_result_barrier', {})],
     [('delegation.childRuns', 1, '迟到不制造第二次委派'), ('delegation.newExecutionsAfterCancel', 0, '取消后没有越权执行'),
      ('delegation.lateResultArchived', True, '迟到结果保留原关联')], variant='recovery')
_add('delegation', 'parallel-disabled', '未启用多子模式保持限制且不宣称覆盖', {'enabledChildModes': ['single']},
     [('request_parallel_child_mode', {})],
     [('delegation.parallelStarts', 0, '未启用模式不启动'), ('delegation.modeDisposition', 'disabled', '明确记录模式限制')],
     variant='permission', control='delegation-single-real-child', enabled=['native_agent_tool'])

# 8. Full, bounded, immutable assessments merged with versioned CAS.
_add('assessment', 'complete-snapshot', '校验结果完整绑定Revision及fieldsHash', {'revision': 1, 'requiredChecks': ['supplier','purchase_order']},
     [('save_candidate', {}), ('accept_revision', {}), ('run_assessments', {}), ('publish_assessment', {})],
     [('assessment.revision', 1, '评估固定Revision'), ('assessment.fieldsHashMatchesRevision', True, '评估固定字段摘要'),
      ('assessment.resultCount', 2, '完整有界结果'), ('assessment.originalCandidatePreserved', True, '保留模型原预测')])
_add('assessment', 'concurrent-merge', '供应商与订单同版本并发返回先合并', {'revision': 1, 'assessmentVersion': 0},
     [('start_assessment', {'check': 'supplier'}), ('start_assessment', {'check': 'purchase_order'}),
      ('release_assessment_barrier', {'order': ['purchase_order','supplier']}), ('read_current_assessment', {})],
     [('assessment.supplierStatus', 'matched', '供应商有效结果保留'), ('assessment.purchaseOrderStatus', 'matched', '订单有效结果保留'),
      ('assessment.lostResults', 0, '并发结果无丢失')], variant='boundary')
_add('assessment', 'cas-reread', '评估CAS冲突重读再合并', {'assessmentVersion': 2, 'concurrentPublishers': 2},
     [('start_assessment_publishers', {'expectedVersion': 2}), ('release_concurrent_commit_barrier', {})],
     [('assessment.casConflicts', 1, '实际触发CAS冲突', 'gte'), ('assessment.rereadsAfterConflict', 1, '冲突后重读', 'gte'),
      ('assessment.lostResults', 0, '重读合并保留有效结果')], variant='boundary')
_add('assessment', 'old-result', '旧代次和旧版本迟到结果不覆盖新结论', {'currentRevision': 2, 'lateResultRevision': 1, 'currentGeneration': 2},
     [('publish_assessment', {'revision': 2}), ('release_old_assessment_result', {'revision': 1, 'generation': 1})],
     [('assessment.currentRevision', 2, '当前结论不回退'), ('assessment.staleResultOverwrites', 0, '旧结果不能覆盖')],
     variant='boundary', control='assessment-complete-snapshot')
_add('assessment', 'missing-check-unknown', '缺失检查项在完整快照明确unknown', {'requiredChecks': ['supplier','purchase_order'], 'availableChecks': ['supplier']},
     [('run_assessments', {}), ('publish_assessment', {})],
     [('assessment.purchaseOrderStatus', 'unknown', '未检查不能记通过'), ('assessment.resultCount', 2, '快照保留全部检查项')], variant='boundary')
_add('assessment', 'field-new-revision', '字段变化创建新修订且保留旧快照', {'revision': 1, 'total': '100.00'},
     [('publish_assessment', {}), ('accept_field_correction', {'total': '101.00'})],
     [('assessment.currentRevision', 2, '字段改变新建Revision'), ('assessment.oldSnapshotPreserved', True, '旧评估历史不可覆盖'),
      ('assessment.originalCandidatePreserved', True, '原预测保留')], variant='boundary')
_add('assessment', 'evidence-only', '仅证据改变更新评估版本及basis并使旧确认失效', {'revision': 1, 'evidenceVersion': 1},
     [('publish_assessment', {}), ('approve_frozen_action', {}), ('replace_evidence', {'version': 2}), ('request_action_admission', {})],
     [('assessment.currentRevision', 1, '字段不变保持Revision'), ('assessment.currentEvidenceVersion', 2, '评估改用新证据'),
      ('approval.oldBasisActive', False, '旧确认失效'), ('external.businessEffects', 0, '旧依据不得发送')],
     variant='permission', control='assessment-reconfirmed-evidence', phase='P12')
_add('assessment', 'reconfirmed-evidence', '证据更新后重新冻结确认可合法准入', {'revision': 1, 'evidenceVersion': 1},
     [('replace_evidence', {'version': 2}), ('publish_assessment', {}), ('freeze_action', {}),
      ('approve_frozen_action', {}), ('request_action_admission', {})],
     [('approval.admission', 'allowed', '重新确认合法放行'), ('approval.basisCovers', ['fields','assessment','target','payload','rules'], 'basis包含完整提交依据')], phase='P12')
_add('assessment', 'restart-stale-basis', '重启恢复不把旧评估确认套用新依据', {'revision': 1, 'ruleVersionBefore': 1, 'ruleVersionAfter': 2},
     [('approve_frozen_action', {}), ('restart_with_current_rules', {'version': 2}), ('request_action_admission', {})],
     [('approval.admission', 'stale_basis', '重启后校验当前完整依据'), ('external.businessEffects', 0, '旧确认没有发送权')],
     variant='recovery', phase='P13', control='assessment-reconfirmed-evidence')

# 9. Accepted, queued, delivered and consumed are separate durable facts.
_add('input', 'consumed-once', '正式输入返回inputId并绑定实际消费Run', {'requestKey': 'SIM-INPUT-01'},
     [('accept_session_input', {'requestKey': 'SIM-INPUT-01'}), ('deliver_input', {}), ('observe_native_consumption', {})],
     [('input.returnedIdentityType', 'inputId', '返回专属输入身份'), ('input.consumptionCount', 1, '实际消费一次'),
      ('input.actualConsumerRunMatches', True, '绑定真实消费Run')])
_add('input', 'queued-not-consumed', '输入排队受理不能提前记为消费', {'runBusy': True},
     [('accept_session_input', {}), ('inspect_input_before_delivery', {})],
     [('input.status', 'queued', '受理后仍排队'), ('input.consumptionCount', 0, '未交付没有消费事实')], variant='boundary')
_add('input', 'same-key-repeat', '相同请求键同内容重复输入幂等', {'requestKey': 'SIM-INPUT-01'},
     [('accept_session_input', {'content': '收件城市苏州'}), ('accept_session_input', {'content': '收件城市苏州'}), ('deliver_input', {})],
     [('input.createdRows', 1, '输入只登记一次'), ('input.consumptionCount', 1, '只消费一次')], variant='boundary', control='input-consumed-once')
for slug, mutation, reason in [('different-content', 'same_key_changed_text', 'request_content_conflict'),
                              ('wrong-job', 'other_job', 'job_mismatch'),
                              ('wrong-session', 'other_session', 'session_mismatch'),
                              ('wrong-run', 'other_run', 'run_mismatch'),
                              ('old-generation', 'retired_generation', 'stale_generation')]:
    _add('input', slug, '会话输入拒绝：' + reason, {'requestKey': 'SIM-INPUT-01'},
         [('accept_session_input', {}), ('deliver_modified_input', {'mutation': mutation})],
         [('input.rejectionReason', reason, '明确拒绝错误输入'), ('input.invalidConsumptions', 0, '错误归属不消费')],
         variant='permission', control='input-consumed-once')
_add('input', 'delivery-unknown', '投递后崩溃先核原生历史不盲重发', {'crashPoint': 'after_delivery_before_ack'},
     [('accept_session_input', {}), ('deliver_input', {}), ('crash_at_delivery_barrier', {}),
      ('restore_and_reconcile_input', {})],
     [('input.historyCheckedBeforeRecovery', True, '先核原生交付证据'), ('input.blindRedeliveries', 0, '不盲重发'),
      ('input.fabricatedConsumptions', 0, '不补造消费事实')], variant='recovery', phase='P13')

# 10. Human business responses are append-only and never submission permission.
_add('interaction', 'valid-answer', '人工回答采纳与修订步骤Job审计原子提交', {'waitingField': 'purchaseOrder'},
     [('open_business_interaction', {}), ('answer_interaction', {'purchaseOrder': 'SIM-PO-01'})],
     [('interaction.returnedIdentityType', 'interactionId', '返回interactionId'), ('interaction.acceptedResponses', 1, '采纳一个有效回答'),
      ('interaction.atomicRevisionStepJobAudit', True, '采纳事务完整')])
_add('interaction', 'duplicate-answer', '重复人工回答不重复推进业务', {'waitingField': 'purchaseOrder'},
     [('open_business_interaction', {}), ('answer_interaction', {'responseKey': 'SIM-RESP-01'}), ('answer_interaction', {'responseKey': 'SIM-RESP-01'})],
     [('interaction.acceptedResponses', 1, '重复回答幂等'), ('interaction.newRevisions', 1, '不重复建修订')], variant='boundary', control='interaction-valid-answer')
_add('interaction', 'correction-append', '人工更正追加记录且保留原回复', {'initialAnswer': 'SIM-PO-01'},
     [('answer_interaction', {'purchaseOrder': 'SIM-PO-01'}), ('correct_interaction', {'purchaseOrder': 'SIM-PO-02'})],
     [('interaction.responseHistoryCount', 2, '更正追加保存'), ('interaction.originalResponsePreserved', True, '原回复不覆盖'),
      ('interaction.currentPurchaseOrder', 'SIM-PO-02', '采纳新的明确答案')], variant='boundary')
_add('interaction', 'ambiguous-answer', '含糊人工回复继续澄清', {'waitingField': 'purchaseOrder'},
     [('open_business_interaction', {}), ('answer_interaction', {'text': '可能是第一个，也可能是另一个'})],
     [('interaction.status', 'waiting', '歧义未解除仍等待'), ('interaction.newRevisions', 0, '不猜测新事实')], variant='boundary')
_add('interaction', 'stale-answer', '旧依据人工回复不能推进新修订', {'interactionRevision': 1, 'currentRevision': 2},
     [('answer_interaction', {'revision': 1})],
     [('interaction.rejectionReason', 'stale_basis', '拒绝旧依据回复'), ('interaction.newRevisions', 0, '不推进当前事实')],
     variant='permission', control='interaction-valid-answer')
_add('interaction', 'field-confirmation-not-approval', '字段确认不能充当提交许可', {'interactionKind': 'field_confirmation'},
     [('answer_interaction', {'text': '同意这个订单号'}), ('request_action_admission', {})],
     [('approval.activeApprovals', 0, '字段确认不生成审批'), ('external.businessEffects', 0, '无正式审批不发送')],
     variant='permission', control='approval-valid-frozen', phase='P12', enabled=['human_business_interaction','frozen_action_approval'])
_add('interaction', 'adoption-rollback', '人工采纳事务中断没有部分修订与步骤推进', {'waitingField': 'purchaseOrder'},
     [('answer_interaction', {'purchaseOrder': 'SIM-PO-01'})],
     [('interaction.partialCommits', 0, '采纳整体回滚'), ('interaction.status', 'waiting', '仍保留原等待')],
     variant='fault', control='interaction-valid-answer', faults=[{'at': 'after_revision_before_step_commit', 'inject': 'database_write_failure'}])

# 11. Formal approval identity and historical send-time decisions.
_add('approval', 'valid-frozen', '可信主体审批冻结Action并原子更新当前审批指针',
     {'actorRole': 'submitter', 'actionState': 'frozen', 'basisVersion': 1},
     [('approve_frozen_action', {}), ('request_action_admission', {})],
     [('approval.returnedIdentityType', 'approvalId', '返回正式approvalId'), ('approval.admission', 'allowed', '合法确认可准入'),
      ('approval.atomicDecisionActionAudit', True, '决定动作指针审计同事务')])
for slug, state, reason in [
 ('wrong-actor', {'actorRole': 'viewer'}, 'unauthorized_actor'),
 ('wrong-action', {'approvedAction': 'A', 'requestedAction': 'B'}, 'action_mismatch'),
 ('expired', {'fixtureClock': '2026-01-16T00:00:00Z', 'expiresAt': '2026-01-15T00:00:00Z'}, 'expired'),
 ('version-conflict', {'expectedVersion': 1, 'currentVersion': 2}, 'version_conflict'),
 ('unfrozen', {'actionState': 'draft'}, 'action_not_frozen'),
 ('ordinary-input', {'submittedTokenType': 'inputId', 'text': '同意'}, 'approval_required'),
 ('interaction-id', {'submittedTokenType': 'interactionId'}, 'approval_required')]:
    _add('approval', slug, '拒绝无效正式审批：' + reason, state,
         [('submit_approval_claim', {}), ('request_action_admission', {})],
         [('approval.admission', reason, '准入说明拒绝原因'), ('external.businessEffects', 0, '无合法审批不产生外部效果')],
         variant='permission', control='approval-valid-frozen')
_add('approval', 'revoke-preserves-decision', '撤销阻止新发送且保留原决定主体时间', {'actionSent': False},
     [('approve_frozen_action', {}), ('revoke_approval', {}), ('request_action_admission', {})],
     [('approval.admission', 'revoked', '撤销后阻止新发送'), ('approval.originalDecisionChanged', False, '原决定不可改写'),
      ('approval.originalActorTimeChanged', False, '原主体时间保留')], variant='permission', control='approval-valid-frozen')
_add('approval', 'late-approval', '迟到旧批准不能把新依据Action推进ready', {'approvedBasis': 1, 'currentBasis': 2},
     [('release_old_approval_command', {'basis': 1})],
     [('approval.actionReadyTransitions', 0, '旧批准不推进ready'), ('approval.admission', 'stale_basis', '旧依据拒绝')],
     variant='boundary', control='approval-valid-frozen')
_add('approval', 'historical-attempt-pointer', '更换Action审批后Attempt仍记录发送时审批', {'firstApprovalAlias': 'A'},
     [('approve_frozen_action', {'alias': 'A'}), ('admit_and_send_attempt', {}),
      ('approve_frozen_action', {'alias': 'B'}), ('query_attempt_history', {})],
     [('approval.actionCurrentAlias', 'B', '当前审批允许改选'), ('approval.sentAttemptAlias', 'A', '旧Attempt保存发送时审批'),
      ('approval.completedResultsOverwritten', 0, '新确认不覆盖已发生结果')], variant='boundary')
_add('approval', 'commit-rollback', '审批事务失败不留下决定或ready动作', {'actionState': 'frozen'},
     [('approve_frozen_action', {})],
     [('approval.partialCommits', 0, '决定指针审计整体回滚'), ('approval.actionReadyTransitions', 0, '失败不授予发送资格')],
     variant='fault', control='approval-valid-frozen', faults=[{'at': 'after_approval_insert_before_action_update', 'inject': 'database_write_failure'}])

# 12. Domain idempotency is about effects, not raw request counts.
_add('dispatch', 'independent-objects', '两个合法独立业务对象各可提交一次',
     {'objects': ['SIM-INV-01','SIM-INV-02'], 'target': 'local-idempotent-b2b'},
     [('freeze_and_approve_objects', {}), ('dispatch_each_object', {}), ('query_authoritative_target', {})],
     [('dispatch.logicalActionCount', 2, '两个对象具有独立逻辑身份'), ('external.businessEffects', 2, '合法独立动作都可生效'),
      ('dispatch.falseDuplicateRejections', 0, '不误拦截不同对象')])
_add('dispatch', 'cross-job-concurrent', '两个Job并发同一逻辑动作最多一个有效Action',
     {'jobs': ['SIM-JOB-A','SIM-JOB-B'], 'businessObject': 'SIM-INV-01'},
     [('freeze_and_approve_in_two_jobs', {}), ('release_concurrent_dispatch_barrier', {}), ('query_authoritative_target', {})],
     [('dispatch.eligibleLogicalActions', 1, '跨Job逻辑动作唯一'), ('dispatch.activeAttempts', 1, '活动Attempt唯一'),
      ('external.businessEffects', 1, '目标只生效一次')], variant='boundary', control='dispatch-independent-objects')
_add('dispatch', 'after-success-new-job', '成功后新建Job不能再次执行同逻辑动作', {'businessObject': 'SIM-INV-01'},
     [('submit_and_verify_success', {'job': 'SIM-JOB-A'}), ('submit_same_object', {'job': 'SIM-JOB-B'}), ('query_authoritative_target', {})],
     [('external.businessEffects', 1, '成功身份跨Job保留防重'), ('dispatch.secondAdmission', 'duplicate_logical_action', '第二个Job被正确阻断')],
     variant='boundary', control='dispatch-independent-objects')
for slug, mutation in [('unknown-new-payload', 'payload'), ('unknown-random-key', 'model_random_idempotency_key'), ('unknown-new-action', 'new_action_id')]:
    _add('dispatch', slug, 'UNKNOWN时变更' + mutation + '不能绕过逻辑防重', {'firstAttemptState': 'UNKNOWN'},
         [('create_real_unknown_attempt', {}), ('resubmit_same_object_with_mutation', {'field': mutation}), ('query_authoritative_target', {})],
         [('dispatch.additionalUnreconciledSends', 0, '未知结果未核对不能新增发送'),
          ('dispatch.eligibleLogicalActions', 1, '变更载荷或随机身份不绕过逻辑唯一性')],
         variant='boundary', control='dispatch-independent-objects')
_add('dispatch', 'lease-not-permission', '仅领取租约不能代替Final Admission', {'actionApproval': None},
     [('claim_dispatch_lease', {}), ('request_send_without_approval', {})],
     [('dispatch.leaseClaims', 1, '确实领取租约'), ('external.requests', 0, '无准入不可发送')],
     variant='permission', control='approval-valid-frozen', enabled=['logical_action_dispatch','frozen_action_approval'])
_add('dispatch', 'duplicate-after-crash', '发送后崩溃租约重取不恢复原Attempt发送许可', {'crashPoint': 'after_send_before_ack'},
     [('admit_and_send_attempt', {}), ('crash_host_at_barrier', {}), ('reclaim_lease', {}), ('redeliver_dispatch', {})],
     [('dispatch.sameAttemptSendCount', 1, '原Attempt仅发送一次'), ('dispatch.reconciliationScheduled', True, '恢复进入核对')],
     variant='recovery', phase='P13')
_add('dispatch', 'query-not-found', 'UNKNOWN查询暂未找到不能盲重发', {'targetVisibility': 'eventually_consistent'},
     [('create_real_unknown_attempt', {}), ('query_authoritative_target', {'fixtureResponse': 'not_yet_visible'}), ('continue_reconciliation', {})],
     [('dispatch.additionalUnreconciledSends', 0, '暂未找到不证明未生效'), ('dispatch.originalAttemptState', 'UNKNOWN', '保留不确定事实')],
     variant='boundary', control='dispatch-safe-retry-contract')
_add('dispatch', 'safe-retry-contract', '契约允许同幂等身份安全重试并保留旧UNKNOWN',
     {'targetContract': 'same_key_same_effect', 'oldAttemptState': 'UNKNOWN'},
     [('establish_retry_basis', {'kind': 'target_idempotency_contract'}), ('stop_old_execution_and_verify', {}),
      ('refresh_action_confirmation', {}), ('atomically_replace_active_attempt', {}), ('send_retry', {}), ('query_authoritative_target', {})],
     [('dispatch.activeAttempts', 1, '退出旧活动资格和新Attempt同事务'), ('dispatch.attemptHistoryCount', 2, '保留两次尝试历史'),
      ('dispatch.oldAttemptState', 'UNKNOWN', '旧UNKNOWN历史保留'), ('dispatch.retryUsesOriginalTargetKey', True, '目标身份稳定'),
      ('external.businessEffects', 1, '合法重试只生效一次'), ('dispatch.retryApprovalMatchesAdmission', True, '每次准入固定当时审批')], variant='recovery')
_add('dispatch', 'safe-retry-no-effect-proof', '权威未生效证明支持重新准入后重试',
     {'targetContract': 'authoritative_no_effect_proof'},
     [('establish_retry_basis', {'kind': 'authoritative_no_effect_proof'}), ('stop_old_execution_and_verify', {}),
      ('refresh_action_confirmation', {}), ('atomically_replace_active_attempt', {}), ('send_retry', {}), ('query_authoritative_target', {})],
     [('dispatch.activeAttempts', 1, '始终只有一个活动Attempt'), ('dispatch.retryUsesOriginalTargetKey', True, '固定目标身份'),
      ('external.businessEffects', 1, '安全重试正常生效')], variant='recovery')
_add('dispatch', 'unsafe-retry-running-old', '旧执行资源未停止不得创建可发送重试', {'oldResourceState': 'running', 'retryContract': 'same_key_same_effect'},
     [('request_safe_retry', {}), ('query_active_attempts', {})],
     [('dispatch.newSendPermits', 0, '旧执行权未失效不放行'), ('dispatch.activeAttempts', 1, '不并存活动Attempt')],
     variant='permission', control='dispatch-safe-retry-contract')
_add('dispatch', 'late-old-receipt', '安全重试后的旧回执保留原尝试关联', {'oldAttemptState': 'UNKNOWN'},
     [('execute_authorized_safe_retry', {}), ('release_old_authoritative_receipt', {}), ('query_attempt_history', {})],
     [('dispatch.lateReceiptMatchesOriginalAttempt', True, '迟到回执归原Attempt'), ('dispatch.attemptHistoryCount', 2, '保留新旧尝试'),
      ('external.businessEffects', 1, '迟到回执不触发再次发送')], variant='recovery')
_add('dispatch', 'success-atomic', '成功回执与完成事实同事务保存', {'target': 'local-idempotent-b2b'},
     [('admit_and_send_attempt', {}), ('accept_authoritative_receipt', {})],
     [('dispatch.receiptAndCompletionAtomic', True, '回执与完成事实原子提交'), ('dispatch.activeAttempts', 0, '成功Attempt退出活动集合')])
_add('dispatch', 'retry-transition-rollback', '新旧活动Attempt切换事务失败保持唯一性', {'oldAttemptState': 'UNKNOWN'},
     [('establish_retry_basis', {'kind': 'target_idempotency_contract'}), ('stop_old_execution_and_verify', {}),
      ('refresh_action_confirmation', {}), ('atomically_replace_active_attempt', {})],
     [('dispatch.activeAttempts', 1, '回滚后仍只有原活动Attempt'), ('dispatch.newSendPermits', 0, '失败事务不发布新发送权'),
      ('dispatch.partialCommits', 0, '没有一半的活动资格切换')], variant='fault', control='dispatch-safe-retry-contract',
     faults=[{'at': 'after_retire_old_before_insert_new_attempt', 'inject': 'database_write_failure'}])

# Missing product capabilities: decision behavior, payload, browser, environments,
# release conclusions and independent Trial scheduling.
_add('prompt', 'answer-from-evidence', '短任务根据可见事实作答无需工具', {},
     [('run_live_model', {})], [('decision.answerProject', '青竹', '回答来自可见资料'), ('decision.unnecessaryToolCalls', 0, '没有无必要的工具')],
     mode='A', input={'task': '资料中的项目代号是什么？', 'documents': [{'text': '项目代号：青竹。'}]})
_add('prompt', 'necessary-read', '目标事实只在获准工具中时先读取再回答', {'readToolFixture': {'project': '青竹'}},
     [('run_live_model_with_read_tool', {})], [('decision.evidenceReadBeforeAnswer', True, '答案使用真实读取证据'), ('decision.answerProject', '青竹', '正确使用结果')],
     mode='A', phase='P2', input={'task': '查询当前项目代号。'})
_add('prompt', 'insufficient-evidence', '必要业务证据缺失时表达未知并停止猜补', {'availableDocuments': []},
     [('run_live_model', {})], [('decision.disposition', 'insufficient_evidence', '不足时保持不确定性'), ('decision.unsupportedBusinessFacts', 0, '没有编造事实')],
     variant='boundary', mode='A', input={'task': '确认该发票对应的采购订单号。', 'documents': []})
_add('prompt', 'legal-paths', '两项独立只读核对允许合法顺序与并行', {'independentChecks': ['supplier','purchase_order']},
     [('run_live_model_with_read_tools', {})], [('decision.requiredEvidenceCount', 2, '两项证据完整'), ('decision.unsupportedOrderPenalties', 0, '不因合法替代路径扣分')],
     mode='A', phase='P8')
_add('payload', 'complete-preview', '预览完整映射目标组织字段明细附件并冻结摘要',
     {'targetOrganization': 'SIM-ORG-A', 'lineCount': 2, 'attachmentCount': 1},
     [('build_submission_preview', {}), ('freeze_payload', {})],
     [('payload.targetOrganization', 'SIM-ORG-A', '目标组织准确'), ('payload.lineCount', 2, '行项目无遗漏'),
      ('payload.attachmentCount', 1, '附件绑定完整'), ('payload.hashMatchesFrozenBytes', True, '摘要对应实际冻结载荷')])
for slug, change in [('line-change', 'lines'), ('attachment-change', 'attachments'), ('target-change', 'targetOrganization')]:
    _add('payload', slug, '冻结后变更' + change + '使旧载荷和确认失效', {'frozenRevision': 1},
         [('build_and_freeze_payload', {}), ('approve_frozen_action', {}), ('change_business_input', {'field': change}), ('request_action_admission', {})],
         [('payload.oldFrozenBasisUsable', False, '旧冻结依据失效'), ('external.businessEffects', 0, '变化后不得沿旧确认发送')],
         variant='permission', control='payload-complete-preview')
_add('browser', 'readback', '页面逐行录入附件上传后回读实际值', {'fixturePage': 'local-b2b-v1', 'lineCount': 2},
     [('login_local_browser_target', {}), ('locate_invoice_form', {}), ('enter_lines_and_attachments', {}), ('readback_form', {})],
     [('browser.readbackLineCount', 2, '实际回读两行'), ('browser.readbackMismatchCount', 0, '页面值与冻结预览一致'),
      ('browser.uploadedAttachmentCount', 1, '上传附件可回读')])
_add('browser', 'mfa-wait', 'MFA出现后进入人工等待并保留页面控制状态', {'fixtureLoginMode': 'mfa_required'},
     [('login_local_browser_target', {}), ('observe_mfa_challenge', {})],
     [('browser.status', 'waiting_for_mfa', '等待可信人工完成MFA'), ('browser.unapprovedBypassAttempts', 0, '不绕过MFA')], variant='boundary')
_add('browser', 'ownership-takeover', '人工接管页面后自动化停止操作', {'initialPageOwner': 'automation'},
     [('open_local_browser_target', {}), ('take_over_page', {}), ('attempt_queued_page_action', {})],
     [('browser.pageOwner', 'human', '页面归人工'), ('browser.automationActionsAfterTakeover', 0, '接管后不自动操作')],
     variant='permission', control='browser-readback')
_add('browser', 'readback-mismatch', '回读金额与冻结载荷不符阻止提交', {'fixturePage': 'local-b2b-v1', 'domTransform': 'change_total_after_entry'},
     [('enter_invoice_form', {}), ('readback_form', {}), ('request_submit', {})],
     [('browser.readbackMismatchCount', 1, '发现真实回读差异'), ('external.businessEffects', 0, '不提交差异载荷')],
     variant='fault', control='browser-readback')
_add('credentials', 'fixed-readonly-target', '只读适配器使用固定环境与账号', {'environment': 'local-readonly-A', 'credentialRef': 'test-vault/account-A'},
     [('bind_readonly_adapter', {}), ('call_read_tool', {})],
     [('adapter.actualEnvironment', 'local-readonly-A', '真实目标环境匹配'), ('adapter.actualAccountAlias', 'account-A', '使用可信绑定身份'),
      ('adapter.modelVisibleSecretCount', 0, '模型看不到秘密')])
_add('credentials', 'environment-mismatch', '参数伪造环境不能改变可信适配器绑定', {'trustedEnvironment': 'local-readonly-A', 'requestedEnvironment': 'local-readonly-B'},
     [('bind_readonly_adapter', {}), ('call_tool_with_forged_environment', {})],
     [('adapter.rejectionReason', 'environment_mismatch', '环境错配拒绝'), ('adapter.foreignEnvironmentRequests', 0, '没有跨环境请求')],
     variant='permission', control='credentials-fixed-readonly-target')
_add('credentials', 'expired-no-fallback', '凭证过期明确拒绝且不回退其他账号', {'credentialStatus': 'expired', 'otherAccountAvailable': True},
     [('bind_readonly_adapter', {}), ('call_read_tool', {})],
     [('adapter.errorClass', 'credential_expired', '凭证过期正确分类'), ('adapter.fallbackAccountRequests', 0, '不换其他身份'),
      ('adapter.evidenceSecretLeaks', 0, '错误及证据无秘密泄漏')], variant='permission', control='credentials-fixed-readonly-target')
_add('credentials', 'historical-target', '环境更新后旧任务保持原目标', {'initialEnvironment': 'local-A'},
     [('create_job', {'alias': 'old'}), ('change_adapter_default', {'environment': 'local-B'}), ('resume_job', {'alias': 'old'})],
     [('adapter.oldJobTarget', 'local-A', '旧任务固定原目标'), ('adapter.silentTargetSwitches', 0, '没有静默切换目标')], variant='boundary', phase='P12')
_add('release', 'matching-conclusion', '适用质量结论与正式发布组合环境范围一致', {'manifestVersion': 2, 'qualityConclusion': 'approved', 'environment': 'local-test'},
     [('register_quality_conclusion', {}), ('request_release', {})],
     [('release.status', 'released', '正确组合可发布'), ('release.conclusionManifestMatches', True, '质量结论精确绑定清单摘要')])
for slug, changed in [('mismatched-candidate', 'manifest_hash'), ('wrong-environment', 'environment'), ('wrong-scope', 'scope')]:
    _add('release', slug, '发布结论不适用于' + changed + '时拒绝', {'qualityConclusionScope': 'original_combination'},
         [('register_quality_conclusion', {}), ('request_release_with_change', {'field': changed})],
         [('release.status', 'rejected', '不接受错配结论'), ('release.newAdmissions', 0, '错配发布不产生新执行权')],
         variant='permission', control='release-matching-conclusion')
_add('release', 'rollback-history', '撤销回退改变后续准入不改历史固定组合', {'oldVersion': 1, 'currentVersion': 2},
     [('start_run', {'version': 2}), ('revoke_release', {'version': 2}), ('rollback_release', {'version': 1}), ('create_job', {})],
     [('release.historicalRunVersion', 2, '历史Run固定组合不改写'), ('release.newJobVersion', 1, '新Job按当前回退版本'),
      ('release.revokedVersionNewAdmissions', 0, '被撤销版本无新准入')], variant='recovery')
_add('trial', 'fixed-provider-single', '固定Provider机制Trial单次执行并独立保存结果', {'trialCount': 1, 'providerMode': 'fixed'},
     [('schedule_trial', {}), ('run_product_fixture_entry', {}), ('persist_trial_result', {})],
     [('trial.completedCount', 1, '单Trial完成'), ('trial.dimension', 'F', '固定Provider仅计机制F'),
      ('trial.productRuns', 1, '实际调用一次正式入口')])
_add('trial', 'live-separate', 'Live模型行为Trial与Provider连通性单独记录', {'providerMode': 'live'},
     [('run_provider_connectivity_probe', {}), ('schedule_live_behavior_trial', {})],
     [('trial.connectivityRecords', 1, '连通性单独记录'), ('trial.behaviorRecords', 1, '行为结果独立记录'),
      ('trial.connectivityUsedAsBehaviorPass', False, '连通不替代行为成功')], mode='F')
_add('trial', 'k-isolation', '重复k次Trial分别隔离身份状态费用', {'k': 3},
     [('schedule_repetitions', {'k': 3}), ('await_trial_batch', {})],
     [('trial.distinctTrialIds', 3, '三次试验身份独立'), ('trial.stateCrossContamination', 0, '不串状态'),
      ('trial.costRecords', 3, '全部成本分别保留')], phase='P4')
_add('trial', 'cancel-queued', '取消批次明确已执行与未执行Trial', {'batchSize': 3, 'concurrency': 1},
     [('schedule_trial_batch', {}), ('hold_first_trial', {}), ('cancel_trial_batch', {})],
     [('trial.startedCount', 1, '只启动首个Trial'), ('trial.cancelledBeforeStart', 2, '剩余两项未执行取消'),
      ('trial.fabricatedPassCount', 0, '取消不填成功结果')], variant='boundary', phase='P4')
_add('trial', 'mismatched-evidence', '错误Trial或版本证据不能进入该Trial评分', {'trialAlias': 'A', 'evidenceTrialAlias': 'B'},
     [('submit_trial_evidence', {}), ('grade_trial', {})],
     [('trial.verdict', 'ERROR', '身份错配属于证据设施契约错误'), ('trial.acceptedForeignEvidence', 0, '拒绝其他Trial证据')],
     variant='fault', control='trial-fixed-provider-single')
_add('trial', 'injected-product-fault', '故意注入的产品故障按场景判分不排除为设施错', {'faultPurpose': 'product_case', 'missingRequiredEvidence': True},
     [('run_declared_fault_trial', {}), ('grade_trial', {})],
     [('trial.excludedAsInfrastructureError', False, '产品故障场景不剔除'), ('trial.verdict', 'UNJUDGEABLE', '缺证据明确不可判定')],
     variant='fault', control='trial-fixed-provider-single')


# §3.24.1 adds explicit scoring groups without creating new top-level identities.
CRITICAL_GROUPS = {
 'dispatch': '| 跨Job动作防重；18.2.13 |',
 'assessment': '| AssessmentSnapshot并发一致性；18.2.10 |',
 'session-history': '| Session身份及原生历史完整性；18.2.3/18.2.4/18.2.8 |',
 'context': '| Context实际调用归属；18.2.5/18.2.7 |',
 'delegation': '| 多子Agent委派身份；18.2.6 |',
}
HOST_RECOVERY_CHECKS = {
 'dispatch': ([('create_real_unknown_attempt', {})],
     [('dispatch.restoredLogicalIdentityMatches', True, '恢复动作保持原可信逻辑键'),
      ('dispatch.restoredAttemptApprovalMatches', True, '恢复Attempt保持发送时审批'),
      ('dispatch.sameAttemptSendCount', 1, 'Host替换不重获原Attempt发送许可')]),
 'assessment': ([('publish_assessment', {'revision': 2, 'evidenceVersion': 2})],
     [('assessment.currentRevision', 2, '恢复当前Revision'),
      ('assessment.currentEvidenceVersion', 2, '恢复当前证据版本'),
      ('assessment.restoredSnapshotHashMatches', True, '恢复不可变评估正文及摘要')]),
 'session-history': ([('run_real_turns_and_capture', {'count': 7}),
                      ('move_native_cursor', {'target': 'captured_prior_entry'})],
     [('session.restoredEntryCountEqualsCommitted', True, '全部原生entry恢复'),
      ('session.cursorEqualsCommitted', True, '恢复活动分支当前位置'),
      ('session.restoredStorageVersionMatches', True, '历史并发版本不回退')]),
 'context': ([('build_and_commit_context', {'alias': 'A'}), ('deliver_model_input', {'context': 'A'}),
             ('call_read_tool', {}), ('save_candidate', {}), ('build_and_commit_context', {'alias': 'B'})],
     [('context.runCurrentAlias', 'B', '恢复当前指针B'),
      ('context.toolSnapshotAlias', 'A', '历史工具仍关联A'),
      ('context.candidateSnapshotAlias', 'A', '历史候选仍关联A')]),
 'delegation': ([('run_parent_until_real_agent_tool', {}), ('hold_before_plugin_identity', {})],
     [('delegation.originalPendingPreserved', True, '恢复原pending子Run'),
      ('delegation.guessedIdentityBindings', 0, '缺失插件身份不猜补'),
      ('delegation.evalSpawnCalls', 0, 'Host恢复不补发子任务')]),
}
for group, anchor in CRITICAL_GROUPS.items():
    source_group = 'session' if group == 'session-history' else group
    prepare_commands, recovery_checks = HOST_RECOVERY_CHECKS[group]
    _add(source_group, 'host-backup-integrity', '跨Host崩溃及备份恢复核验：' + group,
         {'recoveryMode': 'original_instance_host_replacement',
          'oldHostStopRequired': True, 'faultBarrier': 'after_committed_identity'},
         prepare_commands + [('capture_real_committed_state', {}), ('crash_host_at_barrier', {}),
          ('confirm_old_host_stopped_and_execution_fenced', {}),
          ('backup_committed_database_and_files', {}), ('restore_original_instance_on_replacement_host', {}),
          ('verify_all_identity_version_associations', {})],
         recovery_checks + [('recovery.identityMismatches', 0, '恢复保留原身份'), ('recovery.versionMismatches', 0, '恢复版本一致'),
          ('recovery.danglingAssociations', 0, '引用完整'), ('recovery.unauthorizedReplays', 0, '恢复不重放未知动作')],
         variant='recovery', phase='P13', section='3.24.1', anchor=anchor)


SCENARIOS_BY_ID = {scenario['id']: scenario for scenario in SCENARIOS}
if len(SCENARIOS_BY_ID) != len(SCENARIOS):
    raise ValueError('DUPLICATE_HARNESS_SCENARIO_ID')
SCENARIOS_BY_ID['session-inmemory-only']['requiredCapability'] = 'inmemory_session'
SCENARIOS_BY_ID['context-pre-p5-null']['requiredCapability'] = 'readonly_tools'


# Explicit assertion-to-atom links: neither a module label nor a case-level tag
# is enough to claim an independently prepared check for a normative atom.
ATOM_LINKS = {
 '3.24-manifest-binding/hash-and-ownership': [('manifest-hash-mismatch','manifest.rejectionReason'), ('manifest-missing-file','manifest.rejectionReason'), ('manifest-wrong-workspace','manifest.rejectionReason')],
 '3.24-manifest-binding/immutable-run': [('manifest-historical-pin','manifest.oldJobVersion'), ('manifest-historical-pin','runtime.oldSnapshotVersion')],
 '3.24-manifest-binding/current-controls': [('manifest-revoked-control','release.admission')],
 '3.24-input-dataset/immutable-input': [('dataset-backup-pairing','dataset.verifiedPairs'), ('dataset-backup-pairing','dataset.restoredVersion'), ('dataset-foreign-pair','dataset.rejectionReason')],
 '3.24-input-dataset/missing-or-replaced': [('dataset-missing-source','dataset.staleIdentityUses'), ('dataset-replaced-parse','dataset.staleIdentityUses')],
 '3.24-session-lifecycle/identity': [('session-complete-restore','session.productNativeMappingCount'), ('session-pi-id-mismatch','session.rejectionReason'), ('session-format-mismatch','session.rejectionReason'), ('session-duplicate-pi-id','session.rejectionReason'), ('session-wrong-event-session','session.rejectionReason')],
 '3.24-session-lifecycle/initialization': [('session-initialization-failure','session.publishedActiveCount'), ('session-initialization-failure','session.partialCommits'), ('session-initialization-failure','runtime.modelRequests')],
 '3.24-session-lifecycle/full-recovery': [('session-complete-restore','session.restoredEntryCountEqualsCommitted'), ('session-complete-restore','session.cursorEqualsCommitted')],
 '3.24-session-lifecycle/pagination': [('session-complete-restore','session.restoredEntryCountEqualsCommitted'), ('session-complete-restore','session.sequenceGaps')],
 '3.24-session-lifecycle/sqlite-authority': [('session-complete-restore','session.nativeFilesRead')],
 '3.24-native-memory/canonical-hash': [('memory-same-content-idempotent','memory.hashRecomputed'), ('memory-tampered-body-old-hash','memory.rejectionReason'), ('memory-type-column-conflict','memory.rejectionReason'), ('memory-id-column-conflict','memory.rejectionReason'), ('memory-parent-column-conflict','memory.rejectionReason')],
 '3.24-native-memory/idempotency': [('memory-same-content-idempotent','memory.insertedRows'), ('memory-same-id-new-content','memory.rejectionReason')],
 '3.24-native-memory/tree-and-order': [('memory-cycle','memory.rejectionReason'), ('memory-sequence-conflict','memory.rejectionReason'), ('memory-illegal-order','memory.rejectionReason')],
 '3.24-native-memory/references': [('memory-dangling-parent','memory.rejectionReason'), ('memory-dangling-label','memory.rejectionReason'), ('memory-dangling-custom-ref','memory.rejectionReason'), ('memory-cross-session-ref','memory.rejectionReason'), ('memory-dangling-cursor','memory.rejectionReason'), ('memory-dangling-compaction','memory.rejectionReason'), ('memory-dangling-branch-summary','memory.rejectionReason')],
 '3.24-native-memory/legal-root': [('memory-null-root','memory.rootParent'), ('memory-null-root','session.currentEntryId'), ('memory-branch-root-sentinel','memory.branchSummaryFromId'), ('memory-legal-native-roundtrip','memory.arbitraryStringsTreatedAsRefs')],
 '3.24-native-memory/batch-atomicity': [('memory-tampered-body-old-hash','memory.partialInsertedRows'), ('memory-cycle','memory.partialInsertedRows')],
 '3.24-native-memory/native-roundtrip': [('memory-legal-native-roundtrip','memory.roundtripMismatchCount'), ('memory-legal-native-roundtrip','memory.toolAssociationsMismatchCount'), ('session-complete-restore','session.cursorEqualsCommitted')],
 '3.24-context-snapshot/hash-and-identity': [('context-normal-request','context.bodyHashVerified'), ('context-same-content-idempotent','context.insertedSnapshotCount'), ('context-same-id-changed','context.rejectionReason')],
 '3.24-context-snapshot/atomic-publication': [('context-commit-failure','context.partialCommits'), ('context-commit-failure','context.publishedAliasBCount')],
 '3.24-context-snapshot/actual-call': [('context-late-tool-after-switch','context.toolSnapshotAlias'), ('context-model-forged-id','context.rejectionReason'), ('context-cross-run','context.rejectionReason')],
 '3.24-context-snapshot/immutable-history': [('context-late-tool-after-switch','context.candidateSnapshotAlias'), ('context-runtime-snapshot-fixed','runtime.snapshotDigestChanged')],
 '3.24-context-snapshot/no-hash-cycle': [('context-runtime-snapshot-fixed','context.hashDependencyCycles')],
 '3.24-context-snapshot/database-recovery': [('context-sqlite-only-restore','context.restoredSnapshotAlias'), ('context-sqlite-only-restore','context.exportFilesRead')],
 '3.24-persistence-binding/commit-boundary': [('binding-synchronous-commit','binding.outerCallCommitCount'), ('binding-synchronous-commit','binding.pendingAfterReturn'), ('binding-mid-loop-durable','binding.committedEntriesBeforeLoopEnd'), ('binding-mid-loop-durable','binding.listenerOnlyPersistence')],
 '3.24-persistence-binding/single-binding-cas': [('binding-cursor-cas-conflict','binding.conflictedCursorWrites'), ('binding-stale-binding','binding.rejectionReason')],
 '3.24-persistence-binding/cursor-version': [('binding-cursor-version','session.storageVersion')],
 '3.24-persistence-binding/title-atomicity': [('binding-title-atomic','binding.titleTransactionCount'), ('binding-title-interrupted','binding.partialCommits')],
 '3.24-persistence-binding/poison': [('binding-title-interrupted','binding.state'), ('binding-title-interrupted','runtime.toolsAfterSaveFailure'), ('binding-title-interrupted','runtime.abortRequests')],
 '3.24-persistence-binding/last-committed': [('binding-last-committed-recovery','session.restoredCheckpointEqualsCommitted'), ('binding-last-committed-recovery','runtime.automaticUnknownToolReplays'), ('binding-last-committed-recovery','runtime.automaticModelReplays')],
 '3.24-child-delegation/pending-first': [('delegation-single-real-child','delegation.pendingBeforePluginStart')],
 '3.24-child-delegation/slot-identity': [('delegation-multiple-slots','delegation.distinctSlots'), ('delegation-same-slot-repeat','delegation.childRuns')],
 '3.24-child-delegation/trusted-binding': [('delegation-out-of-order-identities','delegation.mappingMismatches'), ('delegation-single-real-child','delegation.trustedIdentityMappings')],
 '3.24-child-delegation/failure-retention': [('delegation-partial-start-failure','delegation.failedChildren'), ('delegation-pending-crash','delegation.originalPendingPreserved')],
 '3.24-child-delegation/no-replay': [('delegation-single-real-child','delegation.evalSpawnCalls'), ('delegation-pending-crash','delegation.evalSpawnCalls'), ('delegation-late-after-cancel','delegation.newExecutionsAfterCancel')],
 '3.24-assessment-basis/immutable-snapshot': [('assessment-complete-snapshot','assessment.revision'), ('assessment-complete-snapshot','assessment.fieldsHashMatchesRevision'), ('assessment-field-new-revision','assessment.oldSnapshotPreserved')],
 '3.24-assessment-basis/merge-cas': [('assessment-concurrent-merge','assessment.lostResults'), ('assessment-cas-reread','assessment.rereadsAfterConflict'), ('assessment-old-result','assessment.staleResultOverwrites')],
 '3.24-assessment-basis/unknown-checks': [('assessment-missing-check-unknown','assessment.purchaseOrderStatus'), ('assessment-missing-check-unknown','assessment.resultCount')],
 '3.24-assessment-basis/changed-basis': [('assessment-field-new-revision','assessment.currentRevision'), ('assessment-evidence-only','assessment.currentEvidenceVersion'), ('assessment-evidence-only','approval.oldBasisActive')],
 '3.24-assessment-basis/full-basis': [('assessment-reconfirmed-evidence','approval.basisCovers')],
 '3.24-session-input/request-idempotency': [('input-same-key-repeat','input.createdRows'), ('input-different-content','input.rejectionReason')],
 '3.24-session-input/delivery-state': [('input-queued-not-consumed','input.consumptionCount'), ('input-delivery-unknown','input.historyCheckedBeforeRecovery')],
 '3.24-session-input/no-blind-redelivery': [('input-delivery-unknown','input.blindRedeliveries'), ('input-delivery-unknown','input.fabricatedConsumptions')],
 '3.24-session-input/ownership': [('input-wrong-job','input.rejectionReason'), ('input-wrong-session','input.rejectionReason'), ('input-wrong-run','input.rejectionReason')],
 '3.24-human-interaction/response-history': [('interaction-duplicate-answer','interaction.acceptedResponses'), ('interaction-correction-append','interaction.originalResponsePreserved')],
 '3.24-human-interaction/atomic-adoption': [('interaction-valid-answer','interaction.atomicRevisionStepJobAudit'), ('interaction-adoption-rollback','interaction.partialCommits')],
 '3.24-human-interaction/clarification': [('interaction-ambiguous-answer','interaction.status'), ('interaction-stale-answer','interaction.newRevisions'), ('interaction-duplicate-answer','interaction.newRevisions')],
 '3.24-human-interaction/not-approval': [('interaction-field-confirmation-not-approval','approval.activeApprovals')],
 '3.24-formal-approval/frozen-action': [('approval-valid-frozen','approval.admission'), ('approval-wrong-actor','approval.admission'), ('approval-unfrozen','approval.admission'), ('approval-expired','approval.admission'), ('approval-version-conflict','approval.admission')],
 '3.24-formal-approval/atomic-decision': [('approval-valid-frozen','approval.atomicDecisionActionAudit'), ('approval-commit-rollback','approval.partialCommits')],
 '3.24-formal-approval/immutable-attempt': [('approval-historical-attempt-pointer','approval.sentAttemptAlias'), ('approval-revoke-preserves-decision','approval.originalDecisionChanged'), ('approval-revoke-preserves-decision','approval.originalActorTimeChanged')],
 '3.24-formal-approval/stale-denial': [('approval-wrong-action','approval.admission'), ('approval-late-approval','approval.actionReadyTransitions'), ('approval-revoke-preserves-decision','approval.admission'), ('assessment-evidence-only','approval.oldBasisActive')],
 '3.24-formal-approval/typed-command': [('approval-ordinary-input','approval.admission'), ('approval-interaction-id','approval.admission')],
 '3.24-action-dispatch/logical-identity': [('dispatch-unknown-random-key','dispatch.eligibleLogicalActions')],
 '3.24-action-dispatch/cross-job-uniqueness': [('dispatch-cross-job-concurrent','dispatch.eligibleLogicalActions'), ('dispatch-after-success-new-job','external.businessEffects'), ('dispatch-independent-objects','dispatch.falseDuplicateRejections')],
 '3.24-action-dispatch/claim-not-permission': [('dispatch-lease-not-permission','external.requests'), ('dispatch-duplicate-after-crash','dispatch.sameAttemptSendCount')],
 '3.24-action-dispatch/unknown-reconciliation': [('dispatch-query-not-found','dispatch.additionalUnreconciledSends')],
 '3.24-action-dispatch/safe-retry': [('dispatch-safe-retry-contract','dispatch.retryUsesOriginalTargetKey'), ('dispatch-safe-retry-no-effect-proof','external.businessEffects'), ('dispatch-unsafe-retry-running-old','dispatch.newSendPermits'), ('dispatch-safe-retry-contract','dispatch.retryApprovalMatchesAdmission')],
 '3.24-action-dispatch/active-attempt': [('dispatch-safe-retry-contract','dispatch.activeAttempts'), ('dispatch-retry-transition-rollback','dispatch.partialCommits')],
 '3.24-action-dispatch/retain-late-receipt': [('dispatch-safe-retry-contract','dispatch.oldAttemptState'), ('dispatch-late-old-receipt','dispatch.lateReceiptMatchesOriginalAttempt'), ('approval-historical-attempt-pointer','approval.sentAttemptAlias')],
 '3.24.1-action-dedup/cross-job': [('dispatch-cross-job-concurrent','external.businessEffects'), ('dispatch-after-success-new-job','external.businessEffects'), ('dispatch-unknown-new-payload','dispatch.additionalUnreconciledSends'), ('dispatch-unknown-random-key','dispatch.additionalUnreconciledSends')],
 '3.24.1-action-dedup/legal-controls': [('dispatch-independent-objects','external.businessEffects'), ('dispatch-safe-retry-contract','external.businessEffects')],
 '3.24.1-action-dedup/authoritative-effects': [('dispatch-independent-objects','external.businessEffects'), ('dispatch-safe-retry-contract','external.businessEffects'), ('dispatch-cross-job-concurrent','external.businessEffects')],
 '3.24.1-assessment-consistency/concurrent-results': [('assessment-concurrent-merge','assessment.lostResults'), ('assessment-cas-reread','assessment.rereadsAfterConflict'), ('assessment-old-result','assessment.staleResultOverwrites')],
 '3.24.1-assessment-consistency/unknown-state': [('assessment-missing-check-unknown','assessment.purchaseOrderStatus')],
 '3.24.1-assessment-consistency/approval-invalidation': [('assessment-evidence-only','approval.oldBasisActive'), ('assessment-reconfirmed-evidence','approval.admission')],
 '3.24.1-session-integrity/invalid-history': [('memory-tampered-body-old-hash','memory.rejectionReason'), ('memory-cycle','memory.partialInsertedRows'), ('memory-dangling-custom-ref','memory.rejectionReason'), ('memory-cross-session-ref','memory.rejectionReason')],
 '3.24.1-session-integrity/identity-initialization': [('session-pi-id-mismatch','runtime.requestsOnRejectedSession'), ('session-initialization-failure','session.publishedActiveCount')],
 '3.24.1-session-integrity/cursor-title-transaction': [('binding-cursor-version','session.storageVersion'), ('binding-title-interrupted','binding.partialCommits')],
 '3.24.1-session-integrity/legal-roundtrip': [('memory-null-root','session.restoreStatus'), ('memory-branch-root-sentinel','memory.danglingReferenceRejections'), ('memory-same-content-idempotent','memory.insertedRows'), ('memory-legal-native-roundtrip','memory.roundtripMismatchCount')],
 '3.24.1-session-integrity/poison-on-failure': [('binding-title-interrupted','binding.state'), ('binding-title-interrupted','runtime.toolsAfterSaveFailure'), ('binding-title-interrupted','runtime.abortRequests')],
 '3.24.1-context-attribution/request-a-after-b': [('context-late-tool-after-switch','context.toolSnapshotAlias'), ('context-late-tool-after-switch','context.candidateSnapshotAlias')],
 '3.24.1-context-attribution/reject-forged-or-cross-run': [('context-model-forged-id','context.rejectionReason'), ('context-cross-run','context.rejectionReason')],
 '3.24.1-context-attribution/failed-publication': [('context-commit-failure','context.publishedAliasBCount'), ('context-commit-failure','context.runCurrentAlias')],
 '3.24.1-context-attribution/recovery-stability': [('context-sqlite-only-restore','context.historicalAssociationChanges'), ('context-runtime-snapshot-fixed','context.hashDependencyCycles')],
 '3.24.1-delegation-identity/distinct-slots': [('delegation-multiple-slots','delegation.childRuns'), ('delegation-same-slot-repeat','delegation.childRuns')],
 '3.24.1-delegation-identity/out-of-order-binding': [('delegation-out-of-order-identities','delegation.mappingMismatches')],
 '3.24.1-delegation-identity/failure-recovery': [('delegation-partial-start-failure','delegation.failedChildren'), ('delegation-pending-crash','delegation.originalPendingPreserved'), ('delegation-pending-crash','delegation.evalSpawnCalls')],
}

for scenario in SCENARIOS:
    scenario['requirementKeys'] = []
for atom, selectors in ATOM_LINKS.items():
    key = 'CRIT-' + atom
    for sid, path in selectors:
        scenario = SCENARIOS_BY_ID[sid]
        matches = [a for a in scenario['expected'] if a['path'] == 'observation.' + path]
        if len(matches) != 1:
            raise ValueError('INVALID_ATOMIC_ASSERTION_SELECTOR: ' + sid + '/' + path)
        matches[0].setdefault('requirementKeys', []).append(key)
        if key not in scenario['requirementKeys']:
            scenario['requirementKeys'].append(key)


from harness_storage_supplement import register as register_storage_supplement, EXISTING_CHECK_LINKS
from harness_runtime_supplement import register as register_runtime_supplement, apply_existing_links, EXISTING_CHECK_LINKS as RUNTIME_CHECK_LINKS
register_storage_supplement(_add, SCENARIOS)
register_runtime_supplement(_add, SCENARIOS)
apply_existing_links(SCENARIOS)
EXISTING_CHECK_LINKS = {**EXISTING_CHECK_LINKS, **RUNTIME_CHECK_LINKS}
SCENARIOS_BY_ID = {scenario['id']:scenario for scenario in SCENARIOS}
if len(SCENARIOS_BY_ID) != len(SCENARIOS):
    raise ValueError('DUPLICATE_HARNESS_SCENARIO')


def materialize_scenario(case):
    """Project a reviewed definition; never merge caller-supplied fixture state.

    Standard case metadata may coexist. Override channels are rejected, not
    silently ignored. Both outputs are fresh copies, so a runner cannot alter
    the catalog or a later Trial by mutating a returned projection.
    """
    sid = case.get('harnessScenarioId')
    if sid not in SCENARIOS_BY_ID:
        raise ValueError('UNKNOWN_HARNESS_SCENARIO')
    forbidden = {'input', 'harness', 'initialState', 'commands', 'faults',
                 'inputOverrides', 'harnessOverrides', 'scenarioOverrides', 'overrides'}
    if forbidden.intersection(case):
        raise ValueError('HARNESS_SCENARIO_OVERRIDES_NOT_ALLOWED')
    if 'initialEnvironment' in case:
        environment = case['initialEnvironment']
        if not isinstance(environment, dict):
            raise ValueError('INVALID_HARNESS_INITIAL_ENVIRONMENT')
        setup = environment.get('scenarioSetup', {})
        if not isinstance(setup, dict):
            raise ValueError('INVALID_HARNESS_SCENARIO_SETUP')
        conditions = setup.get('conditions', {})
        if conditions != {'harnessScenarioId': sid}:
            raise ValueError('HARNESS_SCENARIO_CONDITIONS_MISMATCH')
        if {'input', 'harness', 'commands', 'faults', 'initialState', 'overrides'}.intersection(setup):
            raise ValueError('HARNESS_SCENARIO_OVERRIDES_NOT_ALLOWED')
    scenario = SCENARIOS_BY_ID[sid]
    fixture = {
        'kind': 'declarative_product_adapter_plan',
        'caseId': case.get('id', sid), 'caseVersion': case.get('version', 1),
        'harnessScenarioId': sid, 'fixtureVersion': 1,
        'clock': '2026-01-15T12:00:00Z',
        'networkPolicy': 'local_simulators_only_except_explicit_live_model',
        'initialState': deepcopy(scenario['initialState']),
        'commands': deepcopy(scenario['commands']), 'faults': deepcopy(scenario['faults']),
        'requiredCapability': scenario['requiredCapability'],
        'enabledMode': deepcopy(scenario['enabledMode']),
        'adapterRequirements': deepcopy(scenario['adapterRequirements']),
        'materializationStatus': 'adapter_plan_only', 'executionStatus': 'NOT_RUN',
    }
    return {'status': 'materialized', 'input': deepcopy(scenario['input']),
            'harness': fixture,
            'fixtureValidation': {'actualProductRun': False, 'nativeHistoryFabricated': False,
                                  'adapterPlanOnly': True},
            'limitations': ['离线控制计划已物化；产品适配器、实际执行和原生证据仍待提供。']}
