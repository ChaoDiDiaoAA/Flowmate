"""Workspace, temporary resource and retention contract plans; no run evidence.

register(add, scenarios) uses harness_scenarios._add's normal interface. Every
expected fact has a precise source reference; native state must be captured by
the real product adapter, never manufactured by this catalog.
"""

STATE_PARAMETERS = {
    'archiveBlocker': '受控初始化建立的阻止空间归档的事实；none表示全部准入条件已满足',
    'historyExists': '空间中已有必须保留且可授权查询的历史事实',
    'mappingChange': '尝试原位修改已存在历史业务的环境或数据根映射种类',
    'policyVersion': '可信空间策略当前版本，更新成功后须递增并关联审计',
    'staleExpectedPolicyVersion': '提交策略更新时故意使用的过期并发版本',
    'requestedCwdRoot': '请求的cwd所属根的逻辑角色，不接受模型提供任意绝对路径',
    'parentChildMode': '真实插件通过主LLM Agent工具创建独立子Run的已启用模式',
    'projectionFault': '获准agentDir投影中准备注入的违规资源类别；none表示合法投影',
    'temporaryArtifactCount': '必须先归档和固定证据引用才允许清理的临时产物数量',
    'retentionBlocker': '阻止Session物理清除的受控事实；none表示已满足独立保留策略',
    'nativeJsonlEnabled': '主子原生sessions/JSONL落盘开关；false要求仅SQLite持久化',
    'pluginIsolationSupported': '插件是否支持独立目录、DB会话工厂及受控资源发现隔离',
    'copyPurpose': '备份恢复用途：原实例恢复或使用新身份构造独立测试副本',
    'originalWorkspaceAlias': '备份前原Workspace的逻辑身份，实际ID由产品受控初始化分配',
}
COMMAND_PARAMETERS = {
    'expectedPolicyVersion': '策略条件更新的预期版本；与权威当前版本比较',
    'requestedCwdRoot': STATE_PARAMETERS['requestedCwdRoot'],
    'projectionFault': STATE_PARAMETERS['projectionFault'],
    'mappingChange': STATE_PARAMETERS['mappingChange'],
    'retentionBlocker': STATE_PARAMETERS['retentionBlocker'],
    'copyPurpose': STATE_PARAMETERS['copyPurpose'],
}


# Existing checks already prove these concrete subfacts. These are partial links,
# never a declaration that all clauses of a paragraph are covered.
EXISTING_CHECK_LINKS = {
    ('approval-wrong-actor', 'observation.approval.admission'): ['CRIT-3.22.1-06'],
    ('approval-wrong-action', 'observation.approval.admission'): ['CRIT-3.22.1-06'],
    ('assessment-evidence-only', 'observation.approval.oldBasisActive'): ['CRIT-3.22.1-06'],
    ('isolation/boundary-query-exfiltration', 'observation.isolation.recipientUnauthorizedFields'): ['CRIT-3.22.1-07'],
    ('isolation/allowed-query', 'observation.isolation.requestedOperationAllowed'): ['CRIT-3.22.1-07'],
    ('isolation/allowed-source', 'observation.isolation.legitimateTaskCompleted'): ['CRIT-3.22.2-02'],
    ('isolation/allowed-source', 'observation.isolation.falseRefusal'): ['CRIT-3.22.2-02'],
    ('isolation/boundary-history-injection', 'observation.isolation.observedPropagation'): ['CRIT-3.22.2-03'],
    ('isolation/boundary-compaction-injection', 'observation.isolation.observedPropagation'): ['CRIT-3.22.2-03'],
    ('isolation/boundary-child-summary-injection', 'observation.isolation.observedPropagation'): ['CRIT-3.22.2-03'],
    ('delegation-parallel-disabled', 'observation.delegation.parallelStarts'): ['CRIT-3.22.4-02'],
    ('isolation/cross-workspace', 'observation.isolation.requestedOperationAllowed'): ['CRIT-3.22.4-04'],
    ('runtime/context-selected-only', 'observation.runtime.actualInputFactIds'): ['CRIT-3.23.1-04'],
    ('runtime/context-selected-only', 'observation.runtime.contextWorkspaceVersionBound'): ['CRIT-3.23.1-05'],
    ('manifest-wrong-workspace', 'observation.manifest.rejectionReason'): ['CRIT-3.23.1-05'],
    ('platform/workspace-multiparent', 'observation.platform.crossWorkspaceWriteRejected'): ['CRIT-3.23.1-database-isolation-contract'],
    ('platform/workspace-multiparent', 'observation.platform.partialWriteResidue'): ['CRIT-3.23.1-database-isolation-contract'],
    ('platform/workspace-pause-inflight', 'observation.platform.newAdmissions'): ['CRIT-3.23.2-02'],
    ('platform/workspace-pause-inflight', 'observation.platform.reconciliationAvailable'): ['CRIT-3.23.2-02'],
    ('session-complete-restore', 'observation.session.nativeFilesRead'): ['CRIT-3.23.3-03', 'CRIT-3.23.3-05'],
    ('session-complete-restore', 'observation.session.restoredEntryCountEqualsCommitted'): ['CRIT-3.23.3-03', 'CRIT-3.23.3-05'],
    ('session-complete-restore', 'observation.session.cursorEqualsCommitted'): ['CRIT-3.23.3-05'],
    ('session-inmemory-only', 'observation.session.persistentRestores'): ['CRIT-3.23.3-05'],
    ('runtime/session-safe-rebind', 'observation.runtime.oldListenersRemaining'): ['CRIT-3.23.3-05'],
    ('delegation-single-real-child', 'observation.delegation.evalSpawnCalls'): ['CRIT-3.23.3-06'],
    ('session-host-backup-integrity', 'observation.recovery.danglingAssociations'): ['CRIT-3.23.3-08', 'CRIT-3.24.1-regression'],
    ('dispatch-host-backup-integrity', 'observation.recovery.identityMismatches'): ['CRIT-3.24.1-regression'],
    ('assessment-host-backup-integrity', 'observation.recovery.versionMismatches'): ['CRIT-3.24.1-regression'],
    ('context-host-backup-integrity', 'observation.recovery.danglingAssociations'): ['CRIT-3.24.1-regression'],
    ('delegation-host-backup-integrity', 'observation.recovery.identityMismatches'): ['CRIT-3.24.1-regression'],
    ('submission/confirmed-submit', 'observation.external.submittedSupplierMatchesFrozenPayload'): ['CRIT-4-gold-authority'],
    ('submission/confirmed-submit', 'observation.external.submittedAmountsAndLinesMatchFrozenPayload'): ['CRIT-4-gold-authority'],
}


def register(add, scenarios):
    def emit(group, slug, title, state, commands, assertions, requirement, section,
             anchor, *, phase, module, control=None, variant='normal', enabled=None, faults=()):
        add(group, 'storage-' + slug, title, state, commands, assertions,
            refs=(requirement,), section=section, anchor=anchor, phase=phase,
            module=module, control=control, variant=variant, enabled=enabled, faults=faults)
        scenario = scenarios[-1]
        if enabled:
            scenario['requiredCapability'] = enabled[0]
        scenario['requirementKeys'] = [requirement]
        for assertion in scenario['expected']:
            assertion.setdefault('requirementKeys', []).append(requirement)
        scenario['evidence'] += ['可信实例、Workspace、Run与路径解析的实际归属清单',
                                 '文件与SQLite实际操作账本及故障前后受保护事实对照']

    archive = ('CRIT-3.23.2-03', '3.23.2', 'P13核验archived仅在无活动绑定')
    emit('manifest', 'archive-idle', '无活动与待恢复事项时归档保留历史可查',
         {'archiveBlocker': 'none', 'historyExists': True},
         [('initialize_workspace_with_committed_history', {}), ('request_workspace_archive', {}),
          ('authorized_query_archived_history', {})],
         [('workspace.status', 'archived', '条件满足才进入archived'),
          ('workspace.archivedHistoryReadable', True, '归档后授权历史查询可用'),
          ('workspace.historyDeleted', 0, '归档不删除事实')], *archive,
         phase='P13', module='operations', enabled=['workspace_maintenance'])
    for blocker in ('active_binding', 'inflight_action', 'unresolved_recovery'):
        emit('manifest', 'archive-' + blocker.replace('_', '-'), '存在' + blocker + '拒绝归档',
             {'archiveBlocker': blocker, 'historyExists': True},
             [('initialize_workspace_archive_blocker', {}), ('request_workspace_archive', {})],
             [('workspace.archiveRejected', True, '真实阻断条件存在时拒绝归档'),
              ('workspace.historyDeleted', 0, '拒绝不破坏原事实'),
              ('workspace.inflightFactsChanged', 0, '拒绝不改写在途事实')], *archive,
             phase='P13', module='operations', variant='permission',
             control='manifest-storage-archive-idle', enabled=['workspace_maintenance'])
    emit('manifest', 'mapping-isolated-instance', '新隔离测试实例可使用独立映射且保留原实例历史',
         {'mappingChange':'isolated_instance', 'historyExists':False},
         [('initialize_isolated_instance_under_requested_mapping', {}),
          ('inspect_original_and_test_instance_mapping', {})],
         [('workspace.newInstanceMappingAccepted', True, '新隔离实例的合法映射可用'),
          ('workspace.testInstanceIdentityIsNew', True, '新实例身份与原实例分离'),
          ('workspace.historicalMappingChanges', 0, '不改绑原实例历史')], *archive,
         phase='P13', module='operations', enabled=['workspace_maintenance'])
    for changed in ('environment', 'data_root'):
        emit('manifest', 'mapping-' + changed.replace('_', '-'), '拒绝原位改变历史业务' + changed + '映射',
             {'mappingChange': changed, 'historyExists': True},
             [('initialize_workspace_with_committed_history', {}),
              ('request_workspace_mapping_change', {'mappingChange': changed})],
             [('workspace.mappingChangeRejected', True, '历史映射不能原位改绑'),
              ('workspace.historicalMappingChanges', 0, '历史环境与数据根保持原映射')], *archive,
             phase='P13', module='operations', variant='permission',
             control='manifest-storage-mapping-isolated-instance', enabled=['workspace_maintenance'])

    db = ('CRIT-3.23.1-database-isolation-contract', '3.23.1', '数据库F应包含“引用存在但归属错误”')
    emit('manifest', 'policy-cas-audit', '空间策略条件更新与版本审计一致',
         {'policyVersion': 3}, [('update_workspace_policy', {'expectedPolicyVersion': 3})],
         [('workspace.policyVersion', 4, '成功策略更新递增版本'),
          ('workspace.policyAuditMatchesCommittedUpdate', True, '审计与实际策略事务对应')], *db,
         phase='P13', module='operations', enabled=['workspace_maintenance'])
    emit('manifest', 'policy-stale-cas', '过期策略版本更新无部分提交或伪审计',
         {'policyVersion': 4, 'staleExpectedPolicyVersion': 3},
         [('update_workspace_policy', {'expectedPolicyVersion': 3})],
         [('workspace.policyUpdateRejected', True, '旧版本条件更新失败'),
          ('workspace.policyVersion', 4, '失败保持当前策略版本'),
          ('workspace.partialPolicyAuditCommits', 0, '策略及审计无部分提交')], *db,
         phase='P13', module='operations', variant='fault',
         control='manifest-storage-policy-cas-audit', enabled=['workspace_maintenance'])

    work = ('CRIT-3.23.3-01', '3.23.3', '| runtime/<runId>/work/ |')
    emit('session', 'run-work-root', 'Run仅使用本实例获准临时work目录',
         {'requestedCwdRoot': 'owned_run_work'},
         [('start_run_with_controlled_cwd', {'requestedCwdRoot': 'owned_run_work'}), ('inspect_actual_run_paths', {})],
         [('paths.workOwnedByCurrentRun', True, '实际cwd归当前Run'),
          ('paths.cwdInsideControlledRuntimeRoot', True, '临时目录位于受控实例runtime根')], *work,
         phase='P1', module='foundation', enabled=['inmemory_session'])
    for root in ('source_code', 'source_data', 'quality_data'):
        emit('session', 'forbidden-cwd-' + root.replace('_', '-'), '拒绝使用' + root + '作为运行cwd',
             {'requestedCwdRoot': root},
             [('start_run_with_controlled_cwd', {'requestedCwdRoot': root})],
             [('paths.cwdAdmissionRejected', True, '禁止的根不能成为工作目录'),
              ('runtime.requestsUsingForbiddenCwd', 0, '拒绝后没有在该cwd运行')], *work,
             phase='P1', module='foundation', variant='permission',
             control='session-storage-run-work-root', enabled=['inmemory_session'])
    emit('delegation', 'separate-work-dirs', '真实主子Run不共享可变work目录',
         {'parentChildMode': 'single'},
         [('run_parent_until_real_agent_tool', {}), ('await_plugin_identity', {}),
          ('inspect_actual_parent_child_paths_and_scopes', {})],
         [('paths.parentChildMutableWorkOverlap', False, '父子可变cwd没有重叠'),
          ('paths.childRunOwnsWork', True, '子work明确归子Run'),
          ('paths.childReadsOutsideGrantedScope', 0, '目录隔离不扩大Scope')], *work,
         phase='P11', module='subagents', enabled=['native_agent_tool'])

    agent = ('CRIT-3.23.3-02', '3.23.3', '| runtime/<runId>/agent/ |')
    emit('session', 'private-agent-projection', 'agentDir仅含当前Run获准投影且无历史或认证明文',
         {'projectionFault': 'none'},
         [('create_run_agent_projection', {}), ('inspect_actual_agent_directory_and_discovery', {})],
         [('paths.agentDirOwnedByCurrentRun', True, 'agentDir归本Run'),
          ('paths.unapprovedResourcesLoaded', 0, '未自动发现全局或其他Run资源'),
          ('paths.plaintextCredentialCopies', 0, '未复制认证明文'),
          ('paths.persistentHistoryFilesInAgentDir', 0, '临时agentDir不保存持久历史')], *agent,
         phase='P1', module='foundation', enabled=['inmemory_session'])
    for fault in ('global_resource', 'other_run_resource', 'plaintext_credential', 'persistent_history'):
        emit('session', 'agent-projection-' + fault.replace('_', '-'), '拦截agentDir违规投影：' + fault,
             {'projectionFault': fault},
             [('prepare_controlled_projection_fault', {'projectionFault': fault}),
              ('create_run_agent_projection', {}), ('inspect_actual_agent_directory_and_discovery', {})],
             [('paths.unsafeProjectionRejected', True, '违规资源没有被接纳为获准投影'),
              ('paths.unapprovedResourcesLoaded', 0, '违规资料没有实际加载'),
              ('paths.plaintextCredentialCopies', 0, '秘密未复制'),
              ('paths.persistentHistoryFilesInAgentDir', 0, '未另存历史')], *agent,
             phase='P1', module='foundation', variant='permission',
             control='session-storage-private-agent-projection', enabled=['inmemory_session'])

    artifacts = ('CRIT-3.23.3-04', '3.23.3', '| runs/<runId>/与inputs/<projectionHash>/ |')
    emit('session', 'archive-before-cleanup', '临时产物归档并固定引用后才清理work',
         {'temporaryArtifactCount': 2},
         [('create_temporary_run_artifacts', {}), ('stop_run_and_confirm_handles_released', {}),
          ('archive_required_artifacts_and_pin_references', {}), ('cleanup_owned_run_temp', {}),
          ('resolve_all_retained_evidence_references', {})],
         [('artifacts.archivedBeforeCleanup', True, '归档固定引用先于删除'),
          ('artifacts.deletedTemporaryPathDependencies', 0, '保留证据不依赖已删除绝对路径'),
          ('artifacts.protectedEvidenceOrInputsDeleted', 0, 'runs与inputs独立保留')], *artifacts,
         phase='P4', module='operations', enabled=['sqlite_native_session'])
    emit('session', 'archive-failure-retains-temp', '必要产物归档失败时保留原临时资源',
         {'temporaryArtifactCount': 2},
         [('create_temporary_run_artifacts', {}), ('stop_run_and_confirm_handles_released', {}),
          ('archive_required_artifacts_and_pin_references', {}), ('cleanup_owned_run_temp', {})],
         [('artifacts.unarchivedRequiredArtifactsDeleted', 0, '不能删除尚未安全归档的必要产物'),
          ('artifacts.brokenPublishedReferences', 0, '失败不发布损坏的证据引用')], *artifacts,
         phase='P4', module='operations', variant='fault', control='session-storage-archive-before-cleanup',
         enabled=['sqlite_native_session'], faults=[{'at': 'before_artifact_archive_commit', 'inject': 'archive_write_failure'}])

    children = ('CRIT-3.23.3-06', '3.23.3', 'P11核验插件真实创建的子Session与父Job同空间')
    emit('delegation', 'sqlite-parent-child-recovery', 'JSONL为空时真实主子Session均从SQLite恢复',
         {'nativeJsonlEnabled': False, 'parentChildMode': 'single'},
         [('run_parent_until_real_agent_tool', {}), ('await_child_real_turns_and_capture', {}),
          ('close_parent_child_and_clear_run_temp', {}), ('reopen_parent_child_from_sqlite', {}),
          ('inspect_actual_parent_child_paths_and_scopes', {})],
         [('session.parentHistoryMatchesCommitted', True, '主Session完整恢复'),
          ('session.childHistoryMatchesCommitted', True, '子Session自身历史完整恢复'),
          ('session.nativeJsonlOrTranscriptReads', 0, '主子恢复不读插件JSONL或transcript'),
          ('paths.parentChildMutableAgentOverlap', False, '主子agentDir独立'),
          ('delegation.parentChildWorkspaceMatchesJob', True, '主子同Job和Workspace'),
          ('delegation.recoverySpawnCalls', 0, '恢复与索引不主动触发委派')], *children,
         phase='P11', module='subagents', enabled=['native_agent_tool'])
    emit('delegation', 'unsupported-factory-denied', '插件不能隔离目录与DB工厂时禁用角色',
         {'pluginIsolationSupported': False},
         [('register_controlled_plugin_capability_gap', {}), ('request_child_role_enable', {}),
          ('attempt_parent_agent_tool_call', {})],
         [('delegation.roleEnabled', False, '不支持隔离时不启用该角色'),
          ('delegation.pluginStarts', 0, '被禁用角色未实际启动'),
          ('delegation.capabilityGapRecorded', True, '能力限制明确保留')], *children,
         phase='P11', module='subagents', variant='permission',
         control='delegation-storage-sqlite-parent-child-recovery', enabled=['native_agent_tool'])
    emit('delegation', 'parent-cleanup-protects-child', '清理已停止父Run不删活动子资源与持久历史',
         {'parentChildMode': 'single'},
         [('run_parent_until_real_agent_tool', {}), ('hold_child_at_controlled_barrier', {}),
          ('stop_parent_without_claiming_child_cleanup', {}), ('cleanup_owned_parent_run_temp', {}),
          ('inspect_child_resources_and_history', {})],
         [('paths.activeChildResourcesDeleted', 0, '未停止子资源不被父清理误删'),
          ('session.childPersistentEntriesDeleted', 0, '子SQLite历史保留'),
          ('paths.unconfirmedChildDirectoryReused', False, '未确认停止的子目录不复用')], *children,
         phase='P11', module='subagents', variant='boundary', enabled=['native_agent_tool'])

    retention = ('CRIT-3.23.3-08', '3.23.3', 'P0–P11不实现自动Session清除')
    emit('session', 'retention-eligible', '独立保留策略满足后受控清除无依赖Session',
         {'retentionBlocker': 'none'},
         [('create_committed_native_history', {}), ('establish_retention_conditions', {'retentionBlocker': 'none'}),
          ('request_session_retention_cleanup', {})],
         [('retention.eligibleSessionDeleted', True, '仅满足独立策略的Session可清除'),
          ('retention.unrelatedFactsDeleted', 0, '受控清理不扩展到其他事实')], *retention,
         phase='P13', module='operations', enabled=['session_retention'])
    for blocker in ('active_binding', 'pending_recovery', 'unhandled_error', 'within_retention_period',
                    'branch_dependency', 'other_run_dependency'):
        emit('session', 'retention-' + blocker.replace('_', '-'), '保留策略遇到' + blocker + '禁止清除',
             {'retentionBlocker': blocker},
             [('create_committed_native_history', {}), ('establish_retention_conditions', {'retentionBlocker': blocker}),
              ('request_session_retention_cleanup', {})],
             [('retention.protectedSessionDeleted', False, '仍受保护Session不能删除'),
              ('retention.protectedEntryChanges', 0, '原生entry和引用保持完整')], *retention,
             phase='P13', module='operations', variant='permission',
             control='session-storage-retention-eligible', enabled=['session_retention'])
    emit('session', 'run-end-preserves-history', 'P4关闭单个Run不自动删除其Session', {},
         [('create_committed_native_history', {}), ('close_run_and_clear_temp', {}), ('read_sqlite_history', {})],
         [('retention.sessionStillPresent', True, 'Run结束不删除Session'),
          ('retention.committedEntriesPreserved', True, '原生历史默认保留')], *retention,
         phase='P4', module='sessions', enabled=['sqlite_native_session'])
    emit('session', 'original-instance-restore', '恢复原实例保留Workspace身份和映射',
         {'copyPurpose': 'original_instance', 'originalWorkspaceAlias': 'original-A'},
         [('create_committed_native_history', {}), ('backup_consistent_database_and_references', {}),
          ('restore_original_instance', {}), ('request_session_rebind', {})],
         [('recovery.workspaceIdentityPreserved', True, '原实例恢复不换Workspace'),
          ('recovery.environmentRootMappingPreserved', True, '恢复保持环境和数据根映射'),
          ('recovery.danglingReferencesBeforeRebind', 0, '引用完整之后才重绑定')], *retention,
         phase='P13', module='operations', enabled=['sqlite_native_session'])
    emit('session', 'independent-copy-new-session', '独立测试副本使用新身份和获准事实构造新Session',
         {'copyPurpose': 'independent_test_copy', 'originalWorkspaceAlias': 'original-A'},
         [('backup_consistent_database_and_references', {}),
          ('initialize_independent_test_instance', {'copyPurpose': 'independent_test_copy'}),
          ('import_authorized_inputs_and_business_facts', {}), ('create_new_test_session', {})],
         [('recovery.testInstanceIdentityIsNew', True, '测试实例使用新实例身份'),
          ('recovery.testWorkspaceIdentityIsNew', True, '测试副本使用新Workspace'),
          ('recovery.testSessionIdentityIsNew', True, '按获准事实创建新的测试会话'),
          ('recovery.copiedHistoryActiveBindings', 0, '不把复制原生历史直接绑定新空间')], *retention,
         phase='P13', module='operations', enabled=['sqlite_native_session'])
    emit('session', 'copied-session-cross-workspace-denied', '复制的原Session不能直接重绑独立测试空间',
         {'copyPurpose': 'independent_test_copy', 'originalWorkspaceAlias': 'original-A'},
         [('create_committed_native_history', {}), ('backup_consistent_database_and_references', {}),
          ('initialize_independent_test_instance', {'copyPurpose': 'independent_test_copy'}),
          ('request_original_session_rebind_to_test_workspace', {})],
         [('recovery.copiedSessionRebindRejected', True, '原Session错空间重绑拒绝'),
          ('recovery.copiedHistoryActiveBindings', 0, '复制历史未获得新执行权'),
          ('runtime.requestsUsingForeignHistory', 0, '拒绝后无跨空间历史执行')], *retention,
         phase='P13', module='operations', variant='permission',
         control='session-storage-independent-copy-new-session', enabled=['sqlite_native_session'])

    return scenarios
