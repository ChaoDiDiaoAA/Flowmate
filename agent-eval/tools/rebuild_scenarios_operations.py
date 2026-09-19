"""36 new Operations episodes; declarations only, no product execution or data I/O.

Adapters and observations describe required integration contracts, not implemented
product APIs. All observations must be derived from actual trial evidence. The
synthetic fixture values below never purport to be histories, traces or results.
"""
from copy import deepcopy


# Exact current clauses, individually selected by each assertion below.
CLAUSES = {
    'target': ('MOD-24.target', '19.1', '标记 Test 不能把生产目标变成测试目标'),
    'fixed': ('MOD-24.target', '19.1', '同 Job 的新 Run 不自动选择最新版本'),
    'auth': ('MOD-24.target', '4.1.1', 'getAvailable 的认证可用判断也不等于真实请求已经成功'),
    'secret': ('MOD-24.target', '18.5.2', '文件、控制台、传送和导出均执行脱敏'),
    'export-audit': ('MOD-26.audit', '18.5.2', '日志查询/导出由获准运维入口执行，导出再脱敏并保存审计'),
    'model-fixed': ('MOD-24.target', '4.2', 'P1 关闭自动模型切换，固定有界调用'),
    'report-immutable': ('MOD-27.release', '19.1', '不修改报告摘要冒充同一候选结果'),
    'refresh': ('MOD-24.target', '19.1', '同一身份下的正常认证刷新交 Pi 处理'),
    'identity-change': ('MOD-24.target', '19.1', '账号、模型、服务目标等生效组合改变时按新候选或显式迁移处理'),
    'permission': ('MOD-24.target', '2.6.1', '知道 sessionId、artifactId 或 contextSnapshotId 不构成访问权'),
    'ack': ('MOD-25.host', '2.4', 'Host 持久化 ACK 只确认控制侧对应数据库提交'),
    'lost': ('MOD-25.host', '18.3', '按原请求身份和持久事实核对，不盲目重复业务操作'),
    'commit': ('MOD-25.atomic', '18.3', '事务成功后才发布对应成功通知'),
    'send': ('MOD-25.atomic', '18.3', '提交事务之后才发网络'),
    'failure': ('MOD-25.host', '18.3', '历史保存失败沿用绑定失效与停止规则'),
    'isolate': ('MOD-25.host', '21.14', '保存失败阻断受影响绑定'),
    'reconnect': ('MOD-25.host', '21.14', '重连仅补发已持久事件，不重执行业务'),
    'old': ('MOD-25.host', '18.2.6', '失效执行可追加迟到观察，不得推进新代次业务状态'),
    'cas': ('MOD-25.atomic', '18.3', 'CAS 处理并发，旧快照留存，提交依据覆盖评估摘要'),
    'history': ('MOD-25.host', '20.2.1', '原生会话目录为空不影响恢复'),
    'context': ('MOD-25.atomic', '18.3', '旧快照和历史调用引用不变'),
    'pending': ('MOD-25.host', '15.4', '启动失败或创建中失联保留该待绑定执行记录'),
    'no-spawn': ('MOD-25.host', '15.5', '不主动创建或重新执行子任务'),
    'logs': ('MOD-26.logs', '18.5.4', '单纯诊断文件失败告警'),
    'quota': ('MOD-26.logs', '18.5.3', '重启不清零现存占用'),
    'audit': ('MOD-26.audit', '18.3', '关键业务事实或审计保存失败不得继续依赖未提交状态'),
    'stop': ('MOD-28.stop', '2.5', '已发送动作仍允许受控核对并保存权威结果'),
    'test': ('MOD-27.release', '19.1', '尚未取得对应生产放行的候选仅可在已获准 Test 范围验证'),
    'shadow': ('MOD-27.release', '19.1', 'Shadow 保持只读'),
    'report': ('MOD-27.release', '19.1', '旧测试环境报告不自动证明新目标已通过'),
    'release': ('MOD-27.release', '19.1.1', '审计同事务'),
    'revoked': ('MOD-27.release', '19.1.1', 'revoked 不重新放行，retired 不复活'),
    'new-id': ('MOD-27.release', '19.1.1', '不得换 control_id 规避撤销'),
    'current': ('MOD-27.release', '19.1.1', '不仅在新 Run 启动时检查'),
    'kill': ('MOD-27.release', '19.1.1', '不以较新 release 记录覆盖其他有效停写控制'),
    'rollback': ('MOD-27.rollback', '23.2', '回退只能选择仍获准且兼容的组合'),
    'migrate': ('MOD-27.rollback', '19.1', 'UNKNOWN 尚未解决时仅允许原目标核对'),
    'migration-fail': ('MOD-27.rollback', '23.2', '不启动依赖新结构的业务'),
    'migration-order': ('MOD-27.rollback', '23.2', '保持写禁用并只读检查'),
    'backup': ('MOD-29.backup', '18.4', '固定一致性数据库快照及其所需文件版本、清单和摘要'),
    'restore': ('MOD-29.backup', '18.4', '先隔离旧控制者与执行资源'),
    'qualify': ('MOD-29.backup', '18.4', '旧快照不能恢复许可'),
    'old-backup': ('MOD-29.backup', '18.4', '备份之后可能发生的外部动作不能视为从未执行'),
    'missing': ('MOD-29.backup', '18.4', '必需文件缺失或摘要不符时报告受影响对象'),
    'clone': ('MOD-29.backup', '2.5', '创建独立测试副本则签发新的实例与 Workspace 身份'),
    'retain': ('MOD-29.retention', '20.2.1', '核验全部 Run 和分支依赖'),
    'delete': ('MOD-29.retention', '18.4', '当前指针不再引用不等于可以删除'),
    'archive': ('MOD-29.retention', '2.5', '无活动绑定、在途动作和未解决恢复事项'),
    'path': ('MOD-29.retention', '18.5.3', '不跟随链接删除根外文件'),
}


# Exact Runtime scenario identities for the P13 Operations episodes.  RT-15
# and RT-16 are capability groups; the RTC identity states which concrete
# condition this episode actually exercises.  Keeping this mapping explicit
# prevents a broad parent-like token from being mistaken for reviewed coverage.
P13_RUNTIME_REQUIREMENTS = {
    # IPC acceptance, durable completion and business result are distinct.
    'ops-host-commit': ['RT-15', 'RTC-15-02'],
    'ops-host-ack-delay': ['RT-15', 'RTC-15-02'],
    'ops-host-ack-lost': ['RT-15', 'RTC-15-02'],
    'ops-host-evaluation-cas': ['RT-15', 'RTC-15-02'],
    'ops-host-session-context': ['RT-15', 'RTC-15-02'],
    # Host loss/reconnect/pending work must retain identities and avoid blind replay.
    'ops-host-save-failure': ['RT-15', 'RTC-15-04'],
    'ops-host-crash-sent-action': ['RT-15', 'RTC-15-04'],
    'ops-host-old-binding': ['RT-15', 'RTC-15-04'],
    'ops-host-event-reconnect': ['RT-15', 'RTC-15-04'],
    'ops-host-pending-child': ['RT-15', 'RTC-15-04'],
    'ops-host-diagnostic-degraded': ['RT-15', 'RTC-15-04'],
    'ops-host-audit-fatal': ['RT-15', 'RTC-15-04'],
    # Release qualification and the complete compatibility combination.
    'ops-release-test-candidate': ['RT-16', 'RTC-16-04'],
    'ops-release-shadow': ['RT-16', 'RTC-16-04'],
    'ops-release-revoked': ['RT-16', 'RTC-16-04'],
    'ops-release-report-mismatch': ['RT-16', 'RTC-16-04'],
    # Rollback/migration/backup are recovery-chain compatibility conditions.
    'ops-release-compatible-rollback': ['RT-16', 'RTC-16-05'],
    'ops-release-migration-unknown': ['RT-16', 'RTC-16-05'],
    'ops-release-migration-failed': ['RT-16', 'RTC-16-05'],
    'ops-release-kill-switch': ['RT-16', 'RTC-16-05'],
    'ops-backup-original': ['RT-16', 'RTC-16-05'],
    'ops-backup-clone': ['RT-16', 'RTC-16-05'],
    'ops-backup-missing-file': ['RT-16', 'RTC-16-05'],
    'ops-backup-digest-conflict': ['RT-16', 'RTC-16-05'],
    'ops-backup-old-gap': ['RT-16', 'RTC-16-05'],
    # Retention proves bounded release/cleanup.  The protected case also proves
    # that unresolved recovery references survive cleanup.
    'ops-retention-protected': ['RT-16', 'RTC-16-01', 'RTC-16-05'],
    'ops-retention-expired': ['RT-16', 'RTC-16-01'],
    'ops-retention-junction': ['RT-16', 'RTC-16-01'],
}


CHECK_REQUIREMENTS = {
    ('ops-release-revoked', 'current-revoke-blocks-existing-run'): [
        'CRIT-3.24-manifest-binding/current-controls'],
    ('ops-release-revoked', 'same-hash-no-revival'): [
        'CRIT-3.24-manifest-binding/current-controls'],
    ('ops-release-revoked', 'revoked-dispatch-count'): [
        'CRIT-3.24-manifest-binding/current-controls'],
}


def _runtime_requirements(key, stage):
    if stage != 'P13':
        return ['RT-04']
    try:
        return deepcopy(P13_RUNTIME_REQUIREMENTS[key])
    except KeyError as exc:
        raise ValueError('P13 Operations episode lacks exact Runtime requirement: ' + key) from exc


def _episode(key, group, title, request, before, commands, checks, *,
             control=None, fault=None, stage='P13', permitted=None):
    """Keep each fixture a single sequential experiment, with no hidden reset."""
    before = deepcopy(before)
    # These are authored transition intentions, never required initial DB values.
    transition_plan = {name: before.pop(name) for name in
        ('newState', 'currentVersionAfterAuthorizedUpdate', 'currentRevocation', 'nativeDirectoryAfterStop')
        if name in before}
    declared = []
    for alias, name, expected, calculation in checks:
        metric, section, quote = CLAUSES[alias]
        evidence = ['before-after-authoritative-state', 'independent-boundary-ledger',
                    'raw-' + name]
        owner = ('core/configuration + adapters + runtime-pi' if metric.startswith('MOD-24') else
                 'core/configuration + core/jobs + core/runtime' if metric.startswith('MOD-27') else
                 'core/operations + core/storage + core/memory' if metric.startswith('MOD-29') else
                 'core/runtime + core/submissions + core/operations' if metric.startswith('MOD-28') else
                 'logging + core/operations' if metric == 'MOD-26.logs' else
                 'Kernel + core/storage' if metric == 'MOD-26.audit' else
                 'runtime-host + core/runtime + core/memory + core/storage')
        declared.append({
            'key': name, 'description': 'Calculate: ' + calculation,
            'metricId': metric, 'mode': 'F', 'path': 'observation.' + name,
            'op': 'eq', 'value': expected, 'evidence': evidence,
            'sourceRefs': [{'spec': 'product', 'section': section, 'quote': quote},
                           {'spec': 'evaluation', 'section': '8.5.1', 'quote': '`' + metric + '`'}],
            'implementationSources': [{
                'layer': 'Flowmate 产品实现及 SDK 接入', 'owner': owner,
                'contractRef': 'docs/spec/00_Flowmate完整方案.md#' + section,
                'versionRef': 'Frozen sourceSpecHashes; actual package/configuration versions pending execution manifest',
                'entry': 'Current public Application/Kernel command and injected Runtime/Gateway/storage port',
                'status': 'pending_actual_adapter',
                'attribution': 'Product owner manages facts; runtime-pi observes pinned SDK; Host has no independent authority.'}],
            'preconditions': [
                {'path': 'observation.fixture-established', 'op': 'eq', 'value': True,
                 'description': 'Compare actual pre-command DB rows, file digests, process identities and controlled endpoint receipts with this episode initialState.facts. Require actual setup receipts; transitionPlan is not pre-command fact and cannot be preinstalled to bypass the tested transition. Fault schedules describe later controller commands, not already observed outcomes.',
                 'evidence': ['actual-fixture-receipt', 'before-after-authoritative-state']},
                {'path': 'observation.stimulus-reached', 'op': 'eq', 'value': True,
                 'description': 'Match command request identity and fault-controller boundary receipt to every declared sequential command and exact fault cut. A denied attempt qualifies; no model start or successful recovery is required. Missing actual attempt/fault evidence is unknown.',
                 'evidence': ['actual-command-boundary', 'independent-boundary-ledger']}]})
        requirement_refs = CHECK_REQUIREMENTS.get((key, name))
        if requirement_refs:
            declared[-1]['requirementRefs'] = list(requirement_refs)
        if name == 'report-and-history-immutable':
            declared[-1]['sourceRefs'].append({'spec': 'product', 'section': '19.1',
                'quote': '作为 artifacts 中不可变产物引用保存到 Run'})
        if name == 'auth-no-fallback-account':
            declared[-1]['sourceRefs'].append({'spec': 'product', 'section': '4.2',
                'quote': '生效运行组合改变时禁止继续沿用旧运行快照'})
    refs = []
    for check in declared:
        for ref in check['sourceRefs']:
            if ref not in refs:
                refs.append(ref)
    refs += [{'spec': 'evaluation', 'section': '3.28', 'quote': 'Host持久化ACK'},
             {'spec': 'evaluation', 'section': '3.27', 'quote': '维护命令等没有模型参与的项目只记适用 F'}]
    if stage == 'P13':
        refs += [{'spec': 'evaluation', 'section': '3.24', 'quote': '旧清单不能绕过当前控制'},
                 {'spec': 'evaluation', 'section': '3.25', 'quote': '正常 Run 结束不取消动作或批准发送'},
                 {'spec': 'evaluation', 'section': '3.26', 'quote': '机制成功不能替代效果正确'}]
    steps = [{'id': 'prepare', 'actor': 'trusted_fixture_adapter',
              'command': 'adapter.prepare_isolated_operations_fixture',
              'arguments': {'facts': deepcopy(before), 'syntheticOnly': True,
                            'noPrefilledHistoryOrSuccess': True}}]
    for n, (command, arguments) in enumerate(commands, 1):
        steps.append({'id': 'step-' + str(n), 'actor': 'trusted_product_adapter',
                      'command': 'adapter.' + command, 'arguments': deepcopy(arguments),
                      'after': [steps[-1]['id']]})
    return {
        # Adding exact RTC identities changes requirement metadata and therefore
        # receives an authored revision.  Earlier P2/P12 adapter episodes retain
        # their original authored revision because their RT-04 link is unchanged.
        'version': 3 if key in {'ops-release-revoked'} else (2 if stage == 'P13' else 1),
        'key': key, 'module': 'operations', 'subcapability': group, 'stage': stage,
        'title': title, 'userInput': request, 'input': {'request': request},
        'initialState': {
            'facts': deepcopy(before), 'transitionPlan': transition_plan,
            'legalControl': control is None and fault is None,
            'fixtureKind': 'synthetic_engineering_declaration_not_execution_evidence',
            'adapterStatus': 'pending_actual_adapter',
            'identity': {'instance': 'synthetic-ops-instance', 'workspace': 'synthetic-ops-workspace',
                         'workspaceStatus': 'active', 'maintainer': 'synthetic-maintainer',
                         'role': 'Explicit fixture-scoped maintenance qualification; no implicit business approval'},
            'clock': 'Freeze UTC and per-process monotonic origin at trial start; never compare monotonic clocks across processes.',
            'initialHistory': 'Fresh isolated instance. Any needed native entries/pending records must be produced through real SDK/product commands during fixture setup; never serialized invented history.',
            'targetInitialState': 'Controlled mock endpoint only; no production network or real credentials. Target ledger starts empty unless facts require actual setup action.',
            'permittedInput': permitted or ['Only input.request is user-visible; adapter receives fixture-scoped operational command arguments and selected nonsecret references.'],
            'protectedInput': 'Checks, expected values, private evidence, synthetic secret canary, fault controller and quality documents remain quality-side. Never read real credentials.',
            'runtimeRefs': _runtime_requirements(key, stage),
            'observationContract': 'Use complete actual before/after authoritative snapshots and independent outbound/handler/process ledgers; correlate instance/workspace/job/run/binding/generation/request/action identities. Evaluate each Calculate expression only when every operand and observation interval is present. Missing evidence is unknown, never zero; a successful command response or conditionObserved summary is not evidence.',
            'layerLimits': 'F-only controlled mechanism probe. No real model behavior A, business result B, production outcome or measured recovery quality is claimed.'},
        'steps': steps, 'faults': [fault] if fault else [],
        'expectedOutcome': '; '.join(x[3] for x in checks),
        'forbidden': ['No automatic reissue of model, child, user input or external action after uncertain persistence.',
                      'No manufactured native history, authoritative receipt, runtime trace or product result.',
                      'No real secrets, ERP writes, source parser or complex financial approval workflow.',
                      'Missing current authorization, required artifacts or unknown external facts cannot authorize new execution.'],
        'controlKeys': [control] if control else [],
        'relatedModules': ['foundation', 'events', 'sessions', 'actions'],
        'sourceRefs': refs, 'checks': declared}


def build_scenarios():
    cases = []
    def add(*args, **kwargs):
        cases.append(_episode(*args, **kwargs))

    group = 'adapter-environment-credentials'
    add('ops-adapter-read', group, '测试查询使用固定目标与限定资格', '请读取测试环境中已授权附件的版本号。',
        {'environment': 'Test', 'physicalTarget': 'mock://test-a', 'accountRef': 'test-reader',
         'grant': 'READ artifact fixture-note only', 'artifact': {'body': '版本 3', 'version': 3}},
        [('invoke_gateway_read', {'artifactRef': 'fixture-note', 'targetRef': 'test-a'})],
        [('target', 'fixed-endpoint-read', True, 'Join actual Gateway request to endpoint access log: exactly one READ uses test-a/test-reader and returns the fixture-note version 3 bytes.'),
         ('permission', 'read-scope-preserved', True, 'Compare resolved artifact ownership and current scope at admission: the only handler read belongs to the selected workspace and granted artifact.'),
         ('secret', 'read-secret-exposures', 0, 'Scan complete tool/UI/log/export output bytes against the protected synthetic test-reader canary; count matched occurrences, requiring channel completeness.')], stage='P2')
    add('ops-adapter-test-production', group, 'Test 标签不能改写物理生产目标身份', '请按当前测试配置读取附件版本。',
        {'environment': 'Test', 'approvedPhysicalTarget': 'mock://test-a',
         'configuredTarget': 'mock://production-labelled-trap', 'productionTrap': 'Local closed synthetic listener, never actual production'},
        [('invoke_gateway_read', {'artifactRef': 'fixture-note', 'configuration': 'mislabelled-test'})],
        [('target', 'target-mismatch-rejected', True, 'Compare admission target identity to fixed manifest: mismatch yields an explicit refusal before handler dispatch.'),
         ('target', 'production-trap-requests', 0, 'Count requests in the independent production-labelled trap access ledger over the attempted command interval.'),
         ('fixed', 'manifest-not-relabelled', True, 'Compare immutable manifest bytes and original target refs before/after refusal; equality must hold and no replacement snapshot is published.')], control='ops-adapter-read', stage='P12')
    add('ops-adapter-target-drift', group, '已绑定任务不随注册表最新目标漂移', '请继续用此任务已经绑定的测试目标查询附件。',
        {'jobTarget': 'mock://test-a', 'pinnedAdapter': 'adapter-v1', 'registryLatest': 'adapter-v2 at mock://test-b', 'retainedV1Available': True},
        [('publish_adapter_candidate', {'version': 'adapter-v2', 'target': 'test-b'}),
         ('continue_job_read', {'jobManifest': 'retained-v1', 'artifactRef': 'fixture-note'})],
        [('fixed', 'old-job-keeps-target', True, 'Join new Run RuntimeSnapshot and outbound request to the old Job manifest; both resolve retained adapter-v1/test-a.'),
         ('target', 'new-target-requests', 0, 'Count test-b listener requests for this Job after registry update.'),
         ('fixed', 'old-snapshot-immutable', True, 'Hash historical Run snapshots and manifest bytes before/after publication; all are unchanged while the candidate has a distinct artifact identity.')], control='ops-adapter-read', stage='P12')
    add('ops-adapter-wrong-credential', group, '模型凭据可解析但实际 Provider 请求拒绝认证', '请通过当前模型复述这条合成注记；认证失败时保留错误原因。',
        {'modelTarget': 'mock://provider-a', 'accountRef': 'expired-model-account',
         'credential': 'Synthetic token resolvable by pinned Pi authentication; configured local Provider endpoint rejects it with 401',
         'modelInput': '合成注记：只读测试', 'providerMode': 'Actual native request to declared protocol stub, F only; no real-model A score'},
        [('resolve_model_availability', {'modelRef': 'fixture-model', 'accountRef': 'expired-model-account'}),
         ('invoke_native_provider_request', {'modelRef': 'fixture-model', 'targetRef': 'provider-a', 'input': '合成注记：只读测试'})],
        [('auth', 'auth-failure-not-success', True, 'Join actual ModelRuntime.getAvailable result and Pi credential resolution to the subsequent native Provider request, local endpoint 401 and Run failure; available credentials cannot establish request success.'),
         ('model-fixed', 'auth-no-fallback-account', True, 'Enumerate complete native Provider outbound request ledger: only pinned account/model/endpoint is attempted; no silent account or service fallback.'),
         ('secret', 'auth-error-secret-exposures', 0, 'Scan captured native Provider error/UI/log/export channels for protected synthetic token and its header/query encodings; require complete channels.')], control='ops-adapter-auth-refresh', stage='P12')
    add('ops-adapter-secret-redaction', group, '合成凭据在异常与日志导出链全程脱敏', '请查询测试附件，并导出本次请求的脱敏诊断。',
        {'target': 'mock://test-a', 'credentialCanary': 'SYNTHETIC-OPS-CANARY-NOT-A-REAL-KEY',
         'syntheticErrorAttributes': 'Controlled endpoint includes canary in cookie/header/query fields', 'exportGrant': 'Current request only'},
        [('invoke_gateway_read', {'artifactRef': 'fixture-note', 'controlledError': 'credential-bearing synthetic error'}),
         ('export_bounded_diagnostics', {'filter': 'current-request', 'operator': 'synthetic-maintainer'})],
        [('secret', 'all-channel-redaction', True, 'For complete file/console/IPC/UI/tool/export byte captures, exact canary and its escaped/header/query encodings have zero occurrences while safe errorId remains linkable.'),
         ('export-audit', 'export-audit-linked', True, 'Join trusted maintenance request identity and bounded export artifact to a committed audit_events record with subject, object and scope.'),
         ('target', 'error-no-secret-forward', 0, 'Count non-allowlisted endpoint requests and model/tool deliveries carrying synthetic credentials; require independent egress and payload captures.')], control='ops-adapter-read', stage='P12')
    add('ops-adapter-scope-denied', group, '对象 ID 已知仍核验实际归属', '请打开这个附件引用查看版本号。',
        {'requestedArtifact': 'other-workspace-note', 'actualOwner': 'synthetic-other-workspace',
         'callerGrant': 'Current workspace only', 'forbiddenCanary': 'SYNTHETIC-OTHER-NOTE-CANARY'},
        [('invoke_gateway_read', {'artifactRef': 'other-workspace-note'})],
        [('permission', 'foreign-object-denied', True, 'Join requested artifact ID to actual DB owner and current authorization decision; a mismatched workspace is rejected before actual content read.'),
         ('permission', 'foreign-handler-reads', 0, 'Count resolved foreign-artifact reads in independent instrumented file/handler ledger for this command.'),
         ('secret', 'foreign-content-exposures', 0, 'Count protected foreign-note canary occurrences in complete product response, tool result and log captures.')], control='ops-adapter-read', stage='P2')
    add('ops-adapter-auth-refresh', group, '同一模型身份正常认证刷新保持运行组合', '请通过当前模型处理合成注记，刷新认证后再处理下一条。',
        {'accountRef': 'test-model-account', 'modelRef': 'fixture-model', 'serviceTarget': 'mock://provider-a',
         'authTokens': 'Two synthetic tokens for same account; actual pinned Pi refresh mechanism, never fixture replacement of its result',
         'providerMode': 'Declared local Provider protocol stub, F only; both actual native requests and refresh receipts required'},
        [('invoke_native_provider_request', {'modelRef': 'fixture-model', 'input': '合成注记一'}),
         ('refresh_same_identity_auth', {'nativeResolver': True}),
         ('invoke_native_provider_request', {'modelRef': 'fixture-model', 'input': '合成注记二'})],
        [('refresh', 'same-identity-refresh', True, 'Join actual Pi authentication refresh receipt, nonsecret account/model/endpoint identity and two native outbound requests; same identity persists and actual endpoint responses complete both requests. Synthetic protocol responses prove F only.'),
         ('fixed', 'refresh-no-combination-change', True, 'Compare Job manifest and historical RuntimeSnapshot hashes before/after token refresh; unchanged combination and no unnecessary migration.'),
         ('secret', 'refresh-no-key-hash', True, 'Inspect manifest/snapshot schema and serialized bytes: no token values or hashes derived from either synthetic token; only allowed nonsecret account/version references exist.')], stage='P12')
    add('ops-adapter-account-change', group, '模型认证变成新账号时关闭旧组合准入', '请通过当前固定模型继续处理合成注记。',
        {'pinnedAccount': 'test-model-account', 'newResolvedAccount': 'different-org-model-account',
         'modelAndTargetUnchanged': True, 'newAccountAuthorizedSeparately': False},
        [('change_resolved_account_fixture', {'newAccountRef': 'different-org-model-account'}),
         ('invoke_native_provider_request', {'modelRef': 'fixture-model', 'boundManifest': 'old-account', 'input': '合成注记'})],
        [('identity-change', 'account-drift-blocked', True, 'Compare native nonsecret resolved account to pinned snapshot and decision; differing account requires new candidate/explicit migration and refuses old-combination use.'),
         ('target', 'new-account-dispatches', 0, 'Count new-account actual handler/network requests after the change, excluding the controlled identity-resolution probe.'),
         ('fixed', 'identity-history-preserved', True, 'Compare old Run/Job/snapshot identity references before/after refusal; old account remains recorded, and no silent overwrite occurred.')], control='ops-adapter-auth-refresh', stage='P12')

    group = 'host-persistence-recovery'
    host = {'host': 'Actual runtime-host process at trial execution', 'controlOwner': 'Single controller owns SQLite',
            'binding': 'binding-a', 'generation': 1, 'requestKey': 'storage-request-a',
            'sessionCreation': 'Real SDK setup emits one harmless user/tool exchange, persisted through core/memory'}
    add('ops-host-commit', group, 'Host 等待控制侧真实提交后继续', '请保存会话并读取附件，然后执行已单独批准的测试提交。',
        {**host, 'actionSetup': 'Minimal synthetic action frozen and approved by explicit fixture-scoped approver via product commands; no inherited maintenance privilege'},
        [('commit_native_history', {'requestKey': 'storage-request-a'}),
         ('invoke_following_read', {'artifactRef': 'fixture-note'}),
         ('send_currently_authorized_mock_action', {'target': 'test-a', 'captureAuthoritativeReceipt': True})],
        [('ack', 'ack-after-commit', True, 'Order controller transaction commit LSN/receipt before matching Host ACK receipt, and both before next tool admission using one requestKey/binding/generation.'),
         ('commit', 'history-atomically-published', True, 'Compare SQLite memories plus sessions cursor/storage_version: all requested entries and cursor publish in the same committed transaction exactly once.'),
         ('ack', 'ack-not-business-success', True, 'Compare Job/Run/action status before/after storage ACK alone and before separately requested send: no success transition occurs without separate owner completion evidence.'),
         ('send', 'authorized-action-control-once', True, 'Join current approval/final-admission transaction and independent mock receipt to original action/attempt: exactly one actual send and one effect, with committed audit before network send.')])
    add('ops-host-ack-delay', group, 'IPC listener 返回后仍等待持久提交确认', '请保存会话，再继续读取测试附件。',
        {**host, 'delayBoundary': 'Controller received request; DB transaction not committed'},
        [('hold_controller_commit', {'requestKey': 'storage-request-a'}), ('commit_native_history', {'requestKey': 'storage-request-a', 'waitMode': 'observe-blocked'}),
         ('probe_following_read', {'artifactRef': 'fixture-note'}), ('release_controller_commit', {'requestKey': 'storage-request-a'}),
         ('await_storage_ack_and_continue', {})],
        [('ack', 'no-tool-before-durable-ack', 0, 'Count next-tool handler admissions between IPC listener-return and durable ACK; interval starts from actual receiver receipt and ends at matching commit ACK.'),
         ('commit', 'no-early-durable-claim', True, 'Compare Host persistence notices to controller transaction timeline: no durable-success event exists before controller commit.'),
         ('ack', 'delayed-commit-once', True, 'After release, query original request identity; exactly one commit, one cursor advance and one authorized following read occur.')],
        control='ops-host-commit', fault='Hold DB commit after IPC receive; listener returns without durable confirmation, then release same transaction.')
    add('ops-host-ack-lost', group, '提交已落库但 ACK 丢失按原请求核对', '请恢复这次保存状态不明的会话，先核对原请求。',
        {**host, 'faultCut': 'DB committed; ACK dropped before Host receive'},
        [('drop_matching_commit_ack', {'requestKey': 'storage-request-a'}), ('commit_native_history', {'requestKey': 'storage-request-a'}),
         ('recover_and_query_original_commit', {'requestKey': 'storage-request-a', 'noReissue': True})],
        [('lost', 'original-request-query', True, 'Correlate recovery read to storage-request-a and controller last committed rows; request identity and resulting cursor/hash equal the actual committed transaction.'),
         ('lost', 'business-reissue-count', 0, 'Count new model/tool/external-action sends causally attributed to ACK recovery in complete independent boundary ledger; status query is a READ only.'),
         ('commit', 'one-storage-effect', True, 'Compare memory native IDs, payload hashes and sessions storage_version across commit/recovery: one unique entry set, no duplicate append or second cursor advance.')],
        control='ops-host-commit', fault='Discard only storage-request-a ACK after actual SQLite commit.')
    add('ops-host-save-failure', group, '历史提交失败封禁绑定并保留最后已提交状态', '请保存会话；保存失败时停止本次执行。',
        {**host, 'cut': 'After native in-memory append, before SQLite commit', 'lastCommittedVersion': 1},
        [('fail_history_transaction', {'requestKey': 'storage-request-a', 'cut': 'before-commit'}),
         ('commit_native_history', {'requestKey': 'storage-request-a'}), ('probe_following_read', {'binding': 'binding-a'}),
         ('recover_from_last_committed', {'newRunRequired': True})],
        [('failure', 'failed-binding-isolated', True, 'Join failed transaction, core/runtime binding invalidation and actual resource-stop evidence; no post-failure handler/model admission uses binding-a.'),
         ('commit', 'failed-write-rolled-back', True, 'Compare DB memories/cursor/storage_version to pre-failure snapshot: exact equality and no durable-success notification.'),
         ('history', 'recovery-last-committed-only', True, 'Compare actual restored SDK entry IDs/tree/cursor to DB version 1; uncommitted native append absent, and recovery uses new Run/binding after current authorization.')],
        control='ops-host-commit', fault='Inject transaction rollback before commit after actual native append; do not fake native history.')
    add('ops-host-crash-sent-action', group, 'Host 崩溃后在途 UNKNOWN 沿原动作核对', '请核对崩溃前的提交结果，不要重新提交。',
        {**host, 'actionSetup': 'Through current valid frozen mock-target approval send one minimal action; mock records effect then drops reply',
         'action': 'action-original', 'attempt': 'attempt-original', 'target': 'mock://test-a'},
        [('send_currently_authorized_mock_action', {'actionRef': 'action-original', 'dropResponseAfterEffect': True}),
         ('crash_host_after_send', {}), ('pause_workspace_new_admission', {}),
         ('recover_controlled_reconciliation', {'actionRef': 'action-original', 'target': 'test-a'}),
         ('probe_new_write_admission', {'workspaceState': 'paused'})],
        [('lost', 'original-action-reconciled', True, 'Join submission_actions/attempts and authoritative mock receipt by original action/attempt/target/idempotency identity; recovery query resolves the same external effect.'),
         ('reconnect', 'no-recovery-resend', True, 'Count complete mock submission ledger before/after Host crash: exactly one effective submission and no recovery send request.'),
         ('old', 'unknown-history-retained', True, 'Read attempt/status history: sent and UNKNOWN observations remain associated with original attempt; authoritative receipt is appended and old Run/binding is never reopened.'),
         ('stop', 'paused-query-no-new-send', True, 'Order current Workspace paused/version commit before recovered query and new-send probe; original-action READ succeeds, new-send admission is refused and independent target ledger has zero subsequent sends.')],
        control='ops-host-commit', fault='Actual mock effect, dropped response, then controlled Host crash; never actual production write.')
    add('ops-host-old-binding', group, '重连旧代次迟到提交不能推进新代次', '请在获准恢复后继续当前任务，并保留迟到记录供核对。',
        {**host, 'heldMessage': 'Genuine generation-1 history/result envelope retained by fault transport', 'recovery': 'Generation 2 and new binding after actual old resource isolation'},
        [('hold_old_binding_envelope', {'binding': 'binding-a', 'generation': 1}),
         ('stop_and_rebind_current_generation', {'newGeneration': 2}),
         ('deliver_held_original_envelope', {'repeatCount': 2})],
        [('old', 'old-envelope-no-current-mutation', True, 'Compare generation-2 Job/Run/cursor facts before/after two generation-1 deliveries: no current business/cursor mutation and decisions name stale binding/generation.'),
         ('reconnect', 'old-envelope-no-tools', 0, 'Count tools/model/external sends with invalidated binding-a after its stop boundary, including after reconnect.'),
         ('old', 'late-observation-deduplicated', True, 'Join original source/request identity in controller records: replay appends at most one late observation, preserves original identities and does not rewrite either Run snapshot.')],
        control='ops-host-commit', fault='Delay genuine old-binding envelope until generation 2 is actually admitted, then duplicate its transport delivery.')
    add('ops-host-event-reconnect', group, '断连仅补发已持久事件并保留原序号', '请重新连接并显示这次运行已经保存的进度。',
        {**host, 'sourceEvents': 'Generate three actual persistent events and one nonpersistent progress update using real entry', 'disconnectAfter': 'First event received'},
        [('disconnect_event_transport', {'afterPersistedReceiveCount': 1}),
         ('emit_actual_remaining_events', {'persistentCount': 2, 'volatileProgressCount': 1}),
         ('reconnect_and_replay_from_cursor', {'duplicateLastDurableDelivery': True})],
        [('reconnect', 'durable-event-set-exact', True, 'Set-compare controller runtime_events source IDs/sequences to actual source-side durable event ledger; complete durable set once, volatile progress excluded by frozen policy.'),
         ('reconnect', 'reconnect-execution-count', 0, 'Count model/tool/action invocations attributed to transport reconnection or event replay in independent execution ledger.'),
         ('old', 'event-identities-not-rebased', True, 'Compare every replayed event instance/workspace/Run/binding/generation/source sequence to its original persisted row; no current-binding reassignment.')],
        control='ops-host-commit', fault='Disconnect only event delivery after first durable event; reconnect with one transport duplicate.')
    add('ops-host-evaluation-cas', group, 'Host 迟到评估不能覆盖已提交的新评估', '请保留我已确认的新依据，核对稍后返回的旧评估。',
        {**host, 'revision': 1, 'evaluationSetup': 'Produce independent old and current minimal rule-evaluation artifacts through product rules; no ERP logic',
         'oldExpectedVersion': 1, 'currentVersionAfterAuthorizedUpdate': 2},
        [('hold_evaluation_publish', {'expectedVersion': 1}),
         ('commit_current_evaluation', {'expectedVersion': 1, 'newVersion': 2}),
         ('crash_and_restore_host_transport', {}), ('release_original_evaluation_publish', {'expectedVersion': 1})],
        [('cas', 'late-cas-rejected', True, 'Compare actual CAS expected version 1 against current version 2 and transaction outcome; stale publish rejected and current evaluation pointer/hash unchanged.'),
         ('cas', 'old-evaluation-retained', True, 'Verify both immutable artifact bytes/digests and publication history remain queryable; conflict does not delete the old referenced evaluation.'),
         ('context', 'approval-basis-not-rewritten', True, 'Compare historical accepted evaluation/frozen basis references before/after delayed publish; no stale snapshot replaces current basis and no authority is inferred from late delivery.')],
        control='ops-host-commit', fault='Hold real old CAS request, commit authorized newer evaluation, restart Host, then deliver old request.')
    add('ops-host-session-context', group, '空原生目录仍从数据库恢复完整历史与调用关联', '请恢复此会话并读取当前授权的备注。',
        {**host, 'setup': 'Real SDK creates branch, tool association and committed cursor; product publishes context snapshots before their actual use; actual main LLM invokes one foreground readonly child through pinned Agent tool and both histories commit',
         'nativeDirectoryAfterStop': 'Empty fixture-only native session directory'},
        [('prepare_actual_history_branch_and_context', {'useNativeSdk': True, 'childEntry': 'actual main LLM Agent tool only'}),
         ('stop_host_and_clear_rebuildable_native_directory', {'requireResourceStopped': True}),
         ('restore_original_session_from_database', {}), ('query_existing_child_recovery_index', {}),
         ('invoke_following_read', {'artifactRef': 'fixture-note'})],
        [('history', 'native-tree-restored', True, 'Compare actual restored SDK header, complete entry IDs/payloads/parent links/tree/cursor/tool-call references to SQLite sessions/memories, not plain text exports.'),
         ('context', 'context-call-link-stable', True, 'Join each historical actual request ID to its original context_snapshot_id/body/hash and RuntimeSnapshot reference before/after restart; every original reference remains equal.'),
         ('old', 'new-binding-current-admission', True, 'Inspect resource exit proof and new Run binding plus actual following READ admission: original Session ownership preserved, old binding invalid, current policy checked.'),
         ('no-spawn', 'child-history-query-control', True, 'Join actual recovery-index lookup to original parent/tool/slot and child Session DB history; existing completed child remains queryable, with zero new Agent invocations or child executions.')])
    add('ops-host-pending-child', group, 'Host 在子执行登记后失联不自动补发委派', '请核对未完成的只读子任务登记，保留它的原始身份。',
        {**host, 'childSetup': 'At real trial main LLM invokes pinned plugin Agent tool; child queued row committed before first child model/tool; no adapter spawn',
         'faultBoundary': 'After queued child row commit, hold genuine plugin identity metadata before binding delivery; no child model/tool executes'},
        [('arm_pending_child_host_cut', {'after': 'child-row-commit-and-plugin-identity-before-native-bind', 'holdOriginalIdentityMetadata': True}),
         ('submit_main_readonly_request', {'request': '请委派只读助手核查备注来源。'}),
         ('recover_pending_child_registry', {'noPluginReissue': True}),
         ('deliver_held_original_child_identity', {'noNewPluginInvocation': True})],
        [('pending', 'queued-child-identity-retained', True, 'Compare queued agent_runs row parent_run_id/origin_tool_call_id/delegation_slot/workspace/generation before/after restart; exact original row remains, with pending binding represented by queued Run state.'),
         ('no-spawn', 'recovery-child-reissue-count', 0, 'Count plugin Agent invocations and child starts attributed to recovery, after original LLM invocation; registry query itself must not dispatch.'),
         ('old', 'late-child-cannot-cross-bind', True, 'Join actual delivered original plugin identity metadata by original parent/tool/slot; stale execution admission rejected, original pending/failed fact preserved under runtime owner without attaching metadata to another child.')],
        control='ops-host-session-context', fault='Controlled Host exit after actual queued child registration and held plugin identity metadata before native child binding; release original metadata after recovery. Missing genuine invocation/cut/delivery remains unjudgeable.')
    add('ops-host-diagnostic-degraded', group, '诊断日志容量耗尽只降级且重启不清零', '请读取备注并查看日志健康状态。',
        {**host, 'logQuotaBytes': 4096, 'closedLegacyBytes': 3072, 'activeAllocatedBytes': 1024,
         'retention': 'No segment currently eligible for deletion', 'dbAndAudit': 'Healthy separate storage'},
        [('exhaust_allocated_diagnostic_quota', {'hostDisconnected': True}),
         ('invoke_following_read', {'artifactRef': 'fixture-note'}),
         ('restart_host_preserving_logs', {}), ('query_log_health', {})],
        [('logs', 'diagnostic-degradation-explicit', True, 'Join actual failed log append to bounded droppedCount/loss interval and safe stderr/health degradation; no recursive logger storm or fabricated durable diagnostic success.'),
         ('quota', 'instance-quota-not-reset', True, 'Sum actual app/host/cli legacy and active file bytes before/after restart; allocator includes existing 4096 bytes, new process identity differs, no fresh full quota is granted.'),
         ('logs', 'diagnostic-only-read-completes', True, 'Compare healthy DB/audit transaction and actual authorized read response: diagnostic failure alone does not fabricate business failure/success or shut down unrelated allowed READ.')],
        control='ops-host-commit', fault='Fill synthetic allocated diagnostic quota while IPC disconnected; business DB and audit remain writable.')
    add('ops-host-audit-fatal', group, '关键审计写失败阻断依赖它的新动作', '请执行已授权的测试操作；若关键记录保存失败请停止新写。',
        {**host, 'auditStorage': 'Injected failing transaction', 'diagnosticStorage': 'Healthy',
         'actionSetup': 'Minimal mock action frozen and approved via explicit fixture-scoped approver; not maintainer privilege'},
        [('fail_critical_audit_commit', {'at': 'final-admission-transaction'}),
         ('attempt_currently_authorized_mock_send', {}), ('query_original_action_state', {})],
        [('audit', 'audit-transaction-no-partial-admission', True, 'Compare action lease/attempt/token/audit rows before/after failed final-admission transaction: no partial committed permission and no success notification.'),
         ('audit', 'critical-failure-send-count', 0, 'Count actual mock-target send requests after the failed critical transaction in independent endpoint ledger.'),
         ('audit', 'critical-error-not-diagnostic-only', True, 'Join ErrorDescriptor impact/recovery action and current stop-new-write decision to critical audit failure; safe diagnostic log may exist but cannot substitute missing audit or authorize retry.')],
        control='ops-host-commit', fault='Reject critical audit write in the same final-admission transaction before external send.')

    group = 'release-revocation-migration'
    add('ops-release-test-candidate', group, '候选无需自己的既有成绩即可获准 Test 试评', '请在获准测试范围验证这个新候选。',
        {'releaseState': 'candidate', 'manifest': 'complete immutable test combination', 'ownPriorQualityReport': None,
         'testGrant': 'Explicit fixture Test grant', 'target': 'mock://test-a', 'allowedActions': ['READ']},
        [('register_frozen_candidate', {}), ('admit_candidate_test_probe', {'effect': 'READ'})],
        [('test', 'candidate-test-admitted', True, 'Join current explicit Test grant and complete candidate manifest to actual READ probe; candidate may execute its first test without requiring a report of itself.'),
         ('release', 'candidate-reference-audited', True, 'Compare operational_controls candidate record, immutable artifact hash and same-transaction audit; all refer to the same scope/identity.'),
         ('target', 'candidate-no-production-grant', True, 'Inspect actual target and control rows after test: only mock test READ occurred; no released production or business approval record created.')])
    add('ops-release-shadow', group, 'Shadow 只读对照没有生产写权限', '请在 Shadow 模式核对测试资料并生成预计载荷。',
        {'releaseState': 'released', 'executionMode': 'Shadow', 'physicalTarget': 'mock://shadow-fixture',
         'allowedActions': ['READ'], 'minimalInvoice': {'reference': 'SYN-OPS-1', 'total': '1.00'}},
        [('admit_shadow_read_and_preview', {'submit': False})],
        [('shadow', 'shadow-read-and-preview', True, 'Join actual authorized fixture READ to saved preview artifact; preview bytes and source reference match observed data without external final submission.'),
         ('shadow', 'shadow-effective-writes', 0, 'Count send/mutation effects in independent mock endpoint ledger across the complete Shadow interval.'),
         ('shadow', 'shadow-no-production-score', True, 'Compare current operational_controls and submission_actions to the local preview: Shadow READ/preview creates no production write grant, approval or successful submitted action; a preview is not an authoritative submission result.')])
    add('ops-release-revoked', group, '当前撤销优先于旧清单和换 ID 放行', '请继续原来获准的只读任务，并查询当前放行状态。',
        {'priorState': 'released', 'jobPinnedManifest': 'manifest-a', 'newState': 'revoked',
         'sameHashReregisterId': 'another-control-id', 'currentRun': 'active before revocation'},
        [('revoke_current_release', {'reason': 'synthetic contract revocation'}),
         ('probe_existing_run_tool', {'manifest': 'manifest-a'}),
         ('attempt_reregister_same_release', {'newControlId': 'another-control-id'})],
        [('current', 'current-revoke-blocks-existing-run', True, 'Order committed revoke control/audit before attempted existing-Run tool admission; decision uses current revoked control despite pinned released snapshot.'),
         ('new-id', 'same-hash-no-revival', True, 'Query controls by manifestHash/environment/scope across all control IDs; revoked qualification remains effective and new-ID re-registration grants no release.'),
         ('revoked', 'revoked-dispatch-count', 0, 'Count actual model/tool/new-send admissions after revoke boundary; old manifest existence is not a grant.')], control='ops-release-test-candidate')
    add('ops-release-report-mismatch', group, '旧目标报告不能为新组合提供放行证据', '请检查这个新目标是否具备放行条件。',
        {'candidateTarget': 'mock://test-b', 'candidateHash': 'new-manifest-b',
         'availableReport': {'target': 'mock://test-a', 'manifestRef': 'old-manifest-a'}, 'releaseState': 'candidate'},
        [('request_candidate_validation', {'reportRef': 'old-manifest-a-report'}),
         ('attempt_non_test_admission', {'candidateRef': 'new-manifest-b'})],
        [('report', 'wrong-report-rejected', True, 'Compare report frozen manifest/target/scope hashes to candidate actual fields; mismatches prevent validated/released qualification and are explicitly reported.'),
         ('report-immutable', 'report-and-history-immutable', True, 'Hash original report bytes and old RuntimeSnapshots before/after attempted validation; no rewriting to impersonate matching evidence.'),
         ('test', 'unreleased-non-test-dispatches', 0, 'Count actual non-Test candidate tool/model/send admissions after mismatched-report rejection.')], control='ops-release-test-candidate')
    add('ops-release-compatible-rollback', group, '兼容且仍获准的组合受控回退', '请将测试任务回退到仍获准的兼容版本。',
        {'currentCombination': 'combo-b', 'rollbackCombination': 'combo-a', 'oldCombinationStillReleased': True,
         'compatibility': 'Actual locked SDK history and schema check required', 'pendingActions': 'None after authoritative query'},
        [('stop_new_admission_and_isolate_old', {}), ('backup_and_verify_compatibility', {'targetCombination': 'combo-a'}),
         ('migrate_job_combination', {'targetCombination': 'combo-a'}), ('admit_current_readonly_probe', {})],
        [('rollback', 'rollback-admission-ordered', True, 'Order current authorization/compatibility proof and actual old-resource isolation before new Job generation/Run and first read under combo-a.'),
         ('migration-order', 'write-disabled-during-migration', True, 'Join operational control interval to complete send ledger: no write while backup, migration and read-only checks are underway.'),
         ('rollback', 'historical-facts-preserved', True, 'Hash old Run/Session history/action/receipt rows before/after migration; preserved history and explicit old/new combo audit, no external reversal or revived approvals.')])
    add('ops-release-migration-unknown', group, '迁移不能把未解 UNKNOWN 变为新目标提交', '请检查此任务能否换版本继续，并先核对原提交。',
        {'currentCombination': 'combo-a', 'requestedCombination': 'combo-b', 'originalAction': 'action-a',
         'originalTarget': 'mock://test-a', 'actionSetup': 'Real mock send loses outcome; target query unavailable at fault window'},
        [('establish_unknown_original_action', {'target': 'test-a'}),
         ('request_combination_migration', {'targetCombination': 'combo-b'}),
         ('query_original_action', {'target': 'test-a'})],
        [('migrate', 'unknown-original-target-only', True, 'Join recovery query action/attempt/target to original frozen action and endpoint ledger; unresolved state remains UNKNOWN with original attempt history.'),
         ('migrate', 'migration-new-send-count', 0, 'Count all new send attempts across original and proposed targets after migration request, including changed idempotency keys.'),
         ('rollback', 'migration-no-history-rewrite', True, 'Compare original action payload/approval/attempt and historical Run manifest refs before/after attempted migration; immutable and no current permission synthesized.')],
        control='ops-release-compatible-rollback', fault='Actual sent mock action has missing response and authoritative query remains unavailable during migration decision.')
    add('ops-release-migration-failed', group, '迁移校验失败保留原数据且不启依赖业务', '请安装测试候选并报告兼容检查结果。',
        {'installedSchema': 'schema-a', 'candidateRequires': 'schema-b', 'fault': 'Required migration fails before publish',
         'oldData': 'Retained consistent backup and live data references'},
        [('stop_new_admission_and_isolate_old', {}), ('create_consistent_backup', {}),
         ('attempt_schema_migration', {'injectFailure': 'before-publish'}), ('probe_candidate_start', {})],
        [('migration-fail', 'failed-schema-no-start', 0, 'Count candidate dependent model/tool/business starts after actual failed migration/compatibility receipt.'),
         ('migration-fail', 'original-data-recoverable', True, 'Compare live old-schema records and consistent backup digests/references after failure; original data and verified recovery source remain intact.'),
         ('rollback', 'no-empty-session-fallback', True, 'Inspect Session creation/binding ledger after failed compatibility: no automatically empty Session is created to bypass incompatible native history.')],
        control='ops-release-compatible-rollback', fault='Required schema migration transaction or verification fails before publishing new schema availability.')
    add('ops-release-kill-switch', group, '新放行不能覆盖有效停写控制', '请检查新版本是否可以恢复测试写入。',
        {'releaseState': 'validated', 'killSwitch': 'Active for same workspace and write scope',
         'releaseCandidate': 'new manifest with matching reviewed test evidence',
         'approvedAction': {'confirmationValid': True, 'target': 'mock://test-a',
             'provenance': 'Actual fixture-scoped authorized human command approves frozen action for this exact candidate, target and basis before probe; no inherited maintenance approval',
             'qualification': 'Current revision, assessment, payload, actor, target, credentials, resource grants, deadline and uniqueness all otherwise eligible'}},
        [('release_validated_combination', {'scope': 'test-write'}),
         ('capture_independent_send_prerequisites', {'all_non_stop_conditions_proven': True, 'exclude': 'active-kill-switch-only'}),
         ('attempt_new_write_admission', {'target': 'test-a', 'actionRef': 'approved-action'}),
         ('query_current_controls', {})],
        [('kill', 'strictest-control-enforced', True, 'Join final denial to the actual active Kill Switch control ID/version/scope and newer release; all other send prerequisites were independently proven, so refusal must cite this current stop control, not missing approval or another hidden condition.'),
         ('release', 'release-not-action-approval', True, 'Compare approvals before/after release command; no business approval is minted by configuration or maintenance authority.'),
         ('kill', 'kill-switch-send-count', 0, 'Count independent mock endpoint send attempts after latest release while Kill Switch remains active.')], control='ops-host-commit')
    for check in cases[-1]['checks']:
        check['preconditions'].append({'path': 'observation.non-stop-send-conditions-proven', 'op': 'eq', 'value': True,
            'description': 'Independent pre-admission records prove all current send prerequisites except the active Kill Switch. Missing approval or another denial condition makes this condition untriggered, not a successful Kill Switch test.',
            'evidence': ['current-approval-basis', 'independent-non-stop-admission-prerequisites']})

    group = 'backup-retention-cleanup'
    restore = {'backupScope': 'Consistent SQLite plus necessary source/business files and immutable manifests',
               'nativeHistorySetup': 'Actual SDK emits branch/tool/cursor; product publishes used context snapshot',
               'originalInstance': 'synthetic-ops-instance', 'originalWorkspace': 'synthetic-ops-workspace',
               'grant': 'Current fixture-scoped maintenance plus explicit authorized READ after restore'}
    add('ops-backup-original', group, '联合备份在原实例恢复并实际读取', '请备份测试实例并演练原实例恢复，之后读取获准备注。', restore,
        [('create_consistent_joint_backup', {}), ('isolate_original_controller_and_resources', {}),
         ('restore_original_instance', {}), ('verify_current_qualification_and_read', {'artifactRef': 'fixture-note'})],
        [('backup', 'joint-backup-complete', True, 'Compare backup manifest counts, SQLite consistent checkpoint and all required artifact/source file bytes/digests; completion marker follows these checks.'),
         ('restore', 'original-identity-and-history', True, 'Read restored workspaces/data_root_ref and actual SDK tree/header/cursor/tool links plus context body/hash; compare to pre-backup committed snapshot with same original instance/workspace.'),
         ('qualify', 'restore-separate-current-admission', True, 'Join actual new READ to post-restore current permissions/revocations and fresh binding; restoration completion alone never supplies authorization.')])
    add('ops-backup-clone', group, '独立测试副本签发新身份且重新构造会话', '请从备份建立独立测试副本并查看获准备注。',
        {**restore, 'destination': 'Separate controlled synthetic root', 'clonePermissions': 'New explicit test-only grants; copied old approval has no execution validity'},
        [('create_consistent_joint_backup', {}), ('restore_independent_test_clone', {'issueNewIdentities': True}),
         ('construct_authorized_clone_session', {'businessFactsOnly': True}), ('read_clone_note', {})],
        [('clone', 'clone-identities-distinct', True, 'Compare actual instanceId/workspaceId/data_root_ref in source and clone: distinct IDs and separate resolved roots, with preserved provenance mapping.'),
         ('clone', 'no-copied-native-binding', True, 'Inspect actual clone Run/Session binding and SDK creation receipts: newly constructed authorized Session, never direct binding of copied source native session to new workspace.'),
         ('qualify', 'clone-no-inherited-privileges', True, 'Compare current clone role/control/approval evaluation to copied history: only new explicit test READ grant is used, old release/approval creates zero send eligibility.')])
    add('ops-backup-missing-file', group, '备份缺少必需文件时保留受影响缺口', '请恢复这份测试备份并检查资料是否可用。',
        {**restore, 'missingArtifact': 'required-note', 'manifestStillReferencesIt': True},
        [('create_consistent_joint_backup', {}), ('remove_fixture_backup_member', {'artifactRef': 'required-note'}),
         ('restore_original_instance', {}), ('probe_affected_read', {'artifactRef': 'required-note'})],
        [('missing', 'missing-member-detected', True, 'Anti-join backup manifest required paths against actual restored files: required-note missing; report exact artifact and dependent objects.'),
         ('qualify', 'missing-file-use-count', 0, 'Count actual affected model/tool/new-send admissions after missing-file detection in complete boundary ledger.'),
         ('missing', 'no-reconstructed-fact', True, 'Compare artifacts and history rows after recovery to verified backup records; no log/export/model text is substituted or published as the missing authoritative member.')],
        control='ops-backup-original', fault='Remove only a synthetic backup copy required member after backup construction; never original data.')
    add('ops-backup-digest-conflict', group, '文件存在但摘要冲突不算恢复完整', '请核验测试备份的文件与引用是否一致。',
        {**restore, 'mutatedMember': 'required-note', 'mutation': 'Change one fixture byte without updating fixed digest'},
        [('create_consistent_joint_backup', {}), ('mutate_fixture_backup_member', {'artifactRef': 'required-note', 'retainDeclaredHash': True}),
         ('restore_original_instance', {}), ('probe_affected_read', {'artifactRef': 'required-note'})],
        [('missing', 'digest-mismatch-detected', True, 'Compute SHA-256 over actual restored required-note bytes and compare fixed artifact/manifest hash; mismatch identifies exact dependency and blocks use.'),
         ('backup', 'completion-marker-not-proof', True, 'Compare claimed completion marker with verification record: existing marker cannot override computed digest failure or produce a completed usable restore.'),
         ('qualify', 'digest-conflict-new-admissions', 0, 'Count affected model/tool/new-write admissions after digest conflict, including via alternate alias to same corrupt member.')],
        control='ops-backup-original', fault='Corrupt one byte only in declared synthetic backup member after valid backup.')
    add('ops-backup-old-gap', group, '较早备份缺失后续记录不等于外部未执行', '请恢复较早测试备份，并先核对备份之后的提交情况。',
        {**restore, 'sourceAvailabilityAtStart': 'available', 'externalQueryAtStart': 'available',
         'currentRevocation': 'Plan: withdraw source after actual backup t0 and authorized send t1; make target query unavailable, then restore t0 at t2'},
        [('create_consistent_joint_backup', {}), ('send_currently_authorized_mock_action', {'afterBackup': True}),
         ('withdraw_source_and_make_query_unavailable', {'source': 'fixture-note'}),
         ('restore_earlier_backup', {}), ('probe_new_use_and_query_original_target', {})],
        [('old-backup', 'gap-preserved-as-unknown', True, 'Compare backup time and external independent send ledger to restored DB: absent local attempt is recorded as unresolved external-fact gap, never proof of no send.'),
         ('qualify', 'current-withdrawal-beats-backup', True, 'Join current source withdrawal/control from authoritative post-backup authority to admission; old available flag does not authorize restored source use.'),
         ('old-backup', 'uncertain-gap-resend-count', 0, 'Count all new send requests after restore across paths/keys; only original-target read-only reconciliation is permitted while gap remains unresolved.')],
        control='ops-backup-original', fault='Restore t0 while post-t0 mock effect exists and authoritative result service is unavailable; current withdrawal authority remains available.')
    add('ops-retention-protected', group, '保留清理核验所有引用并拒绝未决空间归档', '请检查这个测试空间能否清理历史并归档。',
        {'sessionSetup': 'Actual Session has ended Run A plus another recoverable Run B and branch dependency',
         'retention': 'Session and referenced artifact still within required retention',
         'pendingRecovery': 'Queued child binding unresolved and original action UNKNOWN created by real setup'},
        [('request_session_history_cleanup', {'sessionRef': 'shared-session'}),
         ('request_workspace_archive', {'workspaceRef': 'synthetic-ops-workspace'})],
        [('retain', 'all-references-preserved', True, 'Traverse actual sessions/memories parent/branch links and every agent_runs reference including recoverable Run B; compare before/after digests, zero referenced entries/artifacts deleted.'),
         ('archive', 'unresolved-archive-refused', True, 'Join actual pending child/UNKNOWN action/current recovery records to archive refusal; Workspace remains its prior state without bypassing unresolved recovery precondition.'),
         ('delete', 'unknown-and-queued-not-erased', True, 'Compare original action/attempt and queued child IDs/status/history before/after maintenance: unchanged persistent facts, no deletion or forced success/failure to enable cleanup.')],
        control='ops-retention-expired')
    add('ops-retention-expired', group, '合法过期临时文件与日志分段受控清理', '请清理此测试实例已经过期且没有引用的临时文件和日志。',
        {'expiredObjects': 'Closed fixture log segment and stopped Run scratch file beyond frozen retention',
         'liveObjects': 'Active log segment, protected SQLite, Session history and retained source artifact',
         'referenceGraph': 'Complete verified graph contains no reference to expired objects', 'authority': 'Qualified maintainer in this instance'},
        [('inspect_full_retention_graph', {}), ('cleanup_expired_owned_resources', {'followLinks': False}),
         ('read_retained_session_and_artifact', {})],
        [('delete', 'only-eligible-objects-removed', True, 'Set-difference actual filesystem inventory before/after deletion equals exactly expired closed segment and stopped scratch file after verified retention/reference checks.'),
         ('retain', 'retained-authorities-intact', True, 'Compare SQLite/session/source-artifact digests and successful read receipts before/after cleanup; active segment, all business facts and required history preserved.'),
         ('path', 'cleanup-boundary-audited', True, 'Resolve each deletion path under owned roots without following links; join maintainer scope and deletion inventory to actual audit/maintenance receipt.')])
    add('ops-retention-junction', group, '清理遇到目录联接不能删除根外目标', '请清理测试日志目录中的过期分段。',
        {'logsRoot': 'Owned synthetic fixture root', 'junction': 'Closed-looking path resolves to separate synthetic sentinel directory',
         'sentinel': 'SYNTHETIC-OUTSIDE-ROOT-NOT-SECRET', 'eligibleRealSegment': 'One genuine closed expired segment'},
        [('create_fixture_junction_trap', {'outsideTarget': 'synthetic-sentinel-root'}),
         ('cleanup_expired_owned_resources', {'followLinks': False}), ('inspect_outside_sentinel', {})],
        [('path', 'junction-target-untouched', True, 'Compare independent resolved-path deletion ledger and sentinel bytes/digest before/after cleanup: no deletion traverses the junction outside logs root.'),
         ('delete', 'real-expired-segment-cleaned', True, 'Diff owned log inventory: actual genuine eligible closed segment removed while the external target and protected files persist; refusal is not blanket nonoperation.'),
         ('retain', 'db-session-no-cascade', True, 'Compare authoritative SQLite/memories/artifacts digests before/after cleanup and inspect deletion ledger: no cross-domain cascading delete.')],
        control='ops-retention-expired', fault='Present a fixture-only directory junction resolving outside owned logs root; no real user paths.')
    return cases
