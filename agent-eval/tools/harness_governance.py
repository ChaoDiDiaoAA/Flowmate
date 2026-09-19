"""Facility/governance obligations, distinct from product Case coverage.

These are implementation/test references and explicit outstanding work, not
execution records. A caller must capture a real test run before attaching any
facility result. Even a passing facility test gives no product coverage credit.
"""


def _obligation(subject, facilities, gaps):
    return {
        'subject': subject,
        'harnessModule': 'eval-infrastructure',
        'evidenceScope': 'evaluation_facility_only',
        'status': 'validation_and_owner_review_required',
        'facilities': [{'path': path, 'symbol': symbol} for path, symbol in facilities],
        'gaps': gaps,
        'actualFacilityRuns': 0,
        'actualProductRuns': 0,
        'productCaseCoverageCredit': False,
        'wholeRequirementSatisfied': False,
    }


ALIGNMENT = 'agent-eval/tests/test_alignment_regressions.py'
OFFLINE = 'agent-eval/tests/test_offline_facilities.py'
MIGRATION = 'agent-eval/tests/test_harness_migration.py'
SCENARIOS = 'agent-eval/tests/test_harness_scenarios.py'
REVIEW = 'agent-eval/tools/test_invoice_review.py'
SOURCE_ALIGNMENT = 'agent-eval/tools/test_invoice_alignment.py'

GOVERNANCE_REQUIREMENTS = {
    'CRIT-3.6.1-coverage-accounting': _obligation('逐子能力覆盖与F/A/B边界', [
        (SOURCE_ALIGNMENT, 'test_labels_are_not_coverage'),
        (SOURCE_ALIGNMENT, 'test_forged_coverage_rejected'),
        (MIGRATION, 'test_assertions_do_not_inherit_all_case_tags')], [
        '产品scenarioId/fixtureVersion与实际产品F证据仍需可信适配器绑定。',
        '设施检查通过不得升级为模型A或业务B，未执行和缺证据子项仍保留。']),
    'CRIT-3.6.1-evidence-authority': _obligation('阶段分母、权威证据与Owner职责', [
        (ALIGNMENT, 'test_plain_product_descriptor_cannot_pass'),
        (ALIGNMENT, 'test_real_bytes_and_seal_are_required'),
        (ALIGNMENT, 'test_fail_survives_missing_required_check')], [
        '各阶段Owner审定的故障屏障、参数和适用分母尚需随产品实现冻结。',
        '普通日志缺席不能替代完整调用账本的零请求证明。']),
    'CRIT-3.22.2-01': _obligation('安全Case骨架与F/A分离', [
        (SOURCE_ALIGNMENT, 'test_positive_controls_independent_and_new_setup_truthful'),
        (SOURCE_ALIGNMENT, 'test_controls_must_be_pinned_and_equivalent'),
        (SCENARIOS, 'test_native_plans_cannot_be_mistaken_for_generated_history')], [
        '攻击者控制范围、实际到达与清理要求仍需逐Case内容审查。',
        '脚本非法调用拒绝不能登记成真实模型抵抗攻击成绩。']),
    'CRIT-3.22.3-01': _obligation('模型、平台控制、实际后果分别评分', [
        (ALIGNMENT, 'test_safety_dimensions_preserve_model_failure'),
        (ALIGNMENT, 'test_generated_safety_leak_fails_without_model_trace')], [
        '独立三维设施汇总不等于已有真实安全Trial；实际模型调用和目标后果待采集。']),
    'CRIT-3.22.3-02': _obligation('攻击到达证明与各状态分母', [
        (ALIGNMENT, 'test_unreached_attack_cannot_pass_model_dimension')], [
        '计划、构造、到达、触发、可判定的真实批次分母及严重度切片尚未执行。']),
    'CRIT-3.22.3-03': _obligation('安全证据不足不得判零违规或PASS', [
        (ALIGNMENT, 'test_fail_survives_missing_required_check'),
        (ALIGNMENT, 'test_generated_no_approval_write_fails_without_admission_evidence'),
        (ALIGNMENT, 'test_unimplemented_required_rule_blocks_whole_case')], [
        '开放性语义泄露的LLM裁判校准和人工复核尚无执行记录。']),
    'CRIT-3.22.4-01': _obligation('合成秘密、受控目标与禁止生产破坏性测试', [
        (OFFLINE, 'test_remote_business_target_rejected'),
        (SCENARIOS, 'test_model_input_has_no_oracle_or_native_fixture_projection'),
        (OFFLINE, 'test_native_history_is_not_fabricated')], [
        '真实产品适配器还须验证实际网络目标、获准对象、数据及动作边界；fixture规则不足以证明运行安全。']),
    'CRIT-3.22.4-03': _obligation('安全回归、修复继承与探索硬约束', [
        ('agent-eval/src/contracts.py', 'aggregate_checks'),
        ('agent-eval/tools/verify_invoice_data.py', 'verify_current_artifacts')], [
        '尚无实际产品持续回归批次、缺陷修复复测或按变更选择子集的执行证据。',
        'Owner、严重度、分母和处置要求须在阶段评审中固定，不能由模块目录替代。']),
    'CRIT-3.23.4-01': _obligation('Workspace机制的权威证据和独立F/A/B结论', [
        (ALIGNMENT, 'test_real_bytes_and_seal_are_required'),
        (ALIGNMENT, 'test_safety_dimensions_preserve_model_failure'),
        (ALIGNMENT, 'test_fail_survives_missing_required_check')], [
        '真实暂停、清理、恢复的控制和文件观测仍待产品适配器；模型文案不能作其证据。']),
    'CRIT-3.23.4-02': _obligation('逻辑角色、真实Trial绑定与跨实例可比性', [
        (ALIGNMENT, 'test_case_and_run_mismatch_rejected'),
        (SCENARIOS, 'test_host_recovery_preserves_only_original_instance_identity')], [
        '真实instance/workspace/Run/Session和策略环境等价映射尚未采集。',
        '当前SIM身份是准备信息，不能签发产品权限或复用历史成绩证明新约束。']),
    'CRIT-3.24-scope': _obligation('精简存储职责与按阶段启用范围', [
        (SCENARIOS, 'test_all_twelve_storage_boundaries_and_five_critical_groups')], [
        '产品各阶段实际表、文件分工尚需产品实现验收；不得以建齐23张表作为早期门槛。',
        '质量资产与评分数据须保持在agent-eval，准备测试目录不算产品存储已实现。']),
    'CRIT-3.24-inherited-constraints': _obligation('继承约束与文档同步不冒充实现', [
        (MIGRATION, 'test_missing_direct_atomic_link_blocks_publication'),
        (MIGRATION, 'test_plain_json_cannot_claim_product_execution'),
        (SCENARIOS, 'test_native_plans_cannot_be_mistaken_for_generated_history')], [
        '真正数据库约束、故障前后记录和模型历史使用仍未执行；长期偏好/跨会话自动共享不在声明范围。']),
    'CRIT-3.24.1-scoring': _obligation('FAIL/UNJUDGEABLE/ERROR/NOT_RUN明确区分', [
        (ALIGNMENT, 'test_fail_survives_missing_required_check'),
        (ALIGNMENT, 'test_unimplemented_required_rule_blocks_whole_case'),
        (MIGRATION, 'test_new_case_prohibitions_cannot_silently_pass'),
        ('agent-eval/src/contracts.py', 'aggregate_checks')], [
        '故意注入产品故障的真实执行尚缺适配器；设施自检不能替代其持久证据。']),
    'CRIT-4-asset-definitions': _obligation('资产分工、集中Benchmark定义与真实Baseline', [
        ('agent-eval/tools/verify_invoice_data.py', 'verify'),
        ('agent-eval/tools/rebuild_benchmarks.py', 'verify'),
        ('agent-eval/tools/review_invoice_data.py', 'validate_current_assets')], [
        '11项Benchmark已有定义与候选成员，内容审核、正式冻结及真实执行Baseline仍未完成；准备材料不是成绩。']),
    'CRIT-4-case-record': _obligation('Case身份、版本、初态、模式和依赖记录', [
        ('agent-eval/tools/verify_invoice_data.py', 'verify'),
        ('agent-eval/tools/invoice_requirements.py', 'validate_coverage'),
        (MIGRATION, 'test_revision_preserves_identity_and_drops_review')], [
        '结构校验不替代内容复核；Gold/Oracle/Rubric适用版本和实际产品绑定须运行前确认。']),
    'CRIT-4-gold-oracle-record': _obligation('Gold/Oracle依据、版本、核验状态和争议', [
        (REVIEW, 'test_current_missing_checks_rejected'),
        (REVIEW, 'test_current_target_hash_checks_and_unresolved_disputes'),
        (REVIEW, 'test_current_gold_still_requires_original_field_review')], [
        '业务决策Gold和新Oracle仍需对应Owner逐项内容核验，不继承字段Gold的人工确认。']),
    'CRIT-4-grader-record': _obligation('Grader检查项、证据、适用性和校准记录', [
        ('agent-eval/src/contracts.py', 'aggregate_checks'),
        ('agent-eval/src/graders/observations.py', 'grade'),
        (ALIGNMENT, 'test_unimplemented_required_rule_blocks_whole_case')], [
        '逐Grader的Owner、版本冻结、适用条件和校准签署尚不完整；代码测试不自动补足治理记录。']),
    'CRIT-4-benchmark-record': _obligation('冻结Benchmark成员和执行比较协议', [
        ('agent-eval/tools/verify_invoice_data.py', 'verify_current_artifacts'),
        ('agent-eval/src/runner/benchmarks.py', 'validate_bundle'),
        ('agent-eval/tests/test_rebuild_benchmarks.py', 'test_rebuilding_same_inputs_changes_no_bytes')], [
        '候选定义及精确成员已有引用，预算/k/门槛、环境与Owner仍待阶段方案确认后审核冻结。',
        '真实产品/采证适配器及实际Baseline仍缺失，设施统计自检不计作产品执行。']),
    'CRIT-4-trial-record': _obligation('真实批次尝试、运行资源、证据和成本身份', [
        ('agent-eval/src/runner/evidence.py', 'load_evidence'),
        (ALIGNMENT, 'test_case_and_run_mismatch_rejected')], [
        '当前尚无真实EvalRun/EvalTrial及全部恢复/子任务关联、环境、费用记录。']),
    'CRIT-4-phased-identities': _obligation('按实际阶段建立身份且不填假身份', [
        (SCENARIOS, 'test_native_plans_cannot_be_mistaken_for_generated_history'),
        (MIGRATION, 'test_plain_json_cannot_claim_product_execution')], [
        '实际产品未启用的Job/审批/ChildRun字段须按适配器标不适用；SIM初态不能充当真实身份。']),
    'CRIT-4-workspace-evidence': _obligation('默认Workspace、清单绑定和恢复身份规则', [
        (SCENARIOS, 'test_host_recovery_preserves_only_original_instance_identity'),
        ('agent-eval/src/runner/evidence.py', 'load_evidence')], [
        '真实Benchmark策略环境映射、实例级空归属例外和实际恢复准入尚待产品证据。']),
    'CRIT-4-append-only-lifecycle': _obligation('修订只追加并保留历史成绩及失败', [
        (MIGRATION, 'test_protected_ledger_cannot_drop_an_asset'),
        ('agent-eval/tools/test_invoice_scope.py', 'test_attested_parent_bytes_survive_archive_and_tampering_is_rejected'),
        (REVIEW, 'test_current_submit_preserves_parent_and_updates_single_index')], [
        '真实运行后的撤回/退役及替代关系尚需相应执行记录；本次仅保存准备资产和既有人工核验链。']),
    'CRIT-4-controlled-spec-refresh': _obligation('受控更新spec/Oracle并保留旧冻结引用', [
        (MIGRATION, 'test_revision_preserves_identity_and_drops_review'),
        (SOURCE_ALIGNMENT, 'test_stale_source_and_wrong_driving_phase_rejected'),
        (REVIEW, 'test_changed_source_cannot_publish_review')], [
        '本次用户授权的准备资产迁移不等于产品数据迁移或内容验收；正式运行前还须发布经核验的冻结成员。']),
    'CRIT-4-phased-preparation': _obligation('按阶段核验且不虚构企业或独立审核签署', [
        (REVIEW, 'test_ai_attestation_is_not_human_verification'),
        (REVIEW, 'test_second_reviewer_must_be_distinct')], [
        '企业业务Gold签署和获准生产关联须在对应阶段取得，本次没有此类审核或生产执行。']),
    'CRIT-4.1-field-fidelity': _obligation('字段原值、十进制和不确定性保留', [
        ('agent-eval/tools/test_invoice_data.py', 'test_decimal_does_not_guess_ambiguous_separator'),
        ('agent-eval/tools/test_gold_clarification.py', 'test_unknown_is_valid_without_inventing_absence_or_alternatives'),
        ('agent-eval/tools/test_gold_clarification.py', 'test_guessed_value_fails_even_with_question')], [
        '未执行产品字段评测，按来源、Parser/模型、版式和异常类别分组的真实结果尚不存在。']),
    'CRIT-4.1-sampling-isolation': _obligation('原票留出、近重复和曝光治理', [
        ('agent-eval/tools/verify_invoice_data.py', 'verify'),
        ('agent-eval/tools/test_invoice_audit.py', 'test_candidate_connected_component_is_not_automatic_leakage_group'),
        (REVIEW, 'test_draft_revision_cannot_silently_move_holdout')], [
        '近重复候选仍需人工审查；接受集曝光审查和独立补集尚未完成，不能冻结验收。',
        '当前仅称原票留出，不能声称未见模板或供应商泛化成绩。']),
}


# Explicit navigation overrides. Tuple order names the primary module followed
# by related modules. This is navigation/applicability, never prepared coverage.
# Unlisted RTC rows can inherit the RT module ownership registry.
RTC_MODULE_OVERRIDES = {
    **{f'RTC-06-{i:02d}': ('compaction',) for i in range(1, 6)},
    'RTC-06-06': ('context', 'memory'),
    'RTC-06-07': ('memory', 'workflow', 'actions'),
    'RTC-06-08': ('memory', 'context'),
    'RTC-06-09': ('memory', 'sessions', 'operations'),
    'RTC-06-10': ('context', 'memory', 'subagents'),
    **{f'RTC-03-{i:02d}': ('agent-runtime', 'context') for i in range(1, 6)},
    **{f'RTC-05-{i:02d}': ('sessions', 'memory') for i in range(1, 6)},
}
RTX_MODULE_OVERRIDES = {
    'RTX-01': ('memory', 'sessions', 'compaction', 'tools'),
    'RTX-02': ('workflow', 'memory', 'actions', 'subagents'),
    'RTX-03': ('extensions', 'sessions', 'tools'),
    'RTX-04': ('tools', 'sessions', 'operations'),
    'RTX-05': ('compaction', 'sessions', 'operations'),
    'RTX-06': ('subagents', 'sessions', 'operations'),
}
