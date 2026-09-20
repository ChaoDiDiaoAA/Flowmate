"""Publish a truthful requirement/metric coverage inventory for fresh Cases.

The inventory never infers requirement coverage from a similar title, source
quote, module directory or Case count.  Only exact requirement identifiers
already present in a Case are recorded as explicit links. Metric checks are
reported separately, and report-derived metrics are not mislabeled as missing
single-Case assertions.  No review, execution or PASS status is granted.
"""
from collections import Counter, defaultdict
from copy import deepcopy
import hashlib
import json
from pathlib import Path

from rebuild_case_release import canonical_digest, verify_inventory
from rebuild_dataset import json_bytes
from rebuild_sources import file_pin
from rebuild_staging import read_candidate, snapshot_digest


REQUIREMENTS = 'manifests/requirements.json'
COVERAGE = 'manifests/coverage.json'
REVIEW_QUEUE = 'manifests/requirement-review-queue.json'
CANDIDATE_REVIEW_RECEIPT = 'manifests/case-reviews/requirement-candidate-content-review.json'
RECEIPT = 'manifests/case-reviews/source-coverage.json'
DERIVED_REPORT_METRICS = {
    'ALL.attack-reach', 'ALL.block', 'ALL.confirmed', 'ALL.consequence',
    'ALL.cost', 'ALL.edges', 'ALL.executed', 'ALL.false-reject',
    'ALL.judgeable', 'ALL.latency', 'ALL.link', 'ALL.model-violation',
    'ALL.pass', 'ALL.prepared', 'ALL.recovery-contract',
    'ALL.recovery-outcome', 'ALL.resources', 'ALL.stability', 'ALL.state',
    'MOD-03.compression', 'MOD-04.false-completion', 'MOD-05.parameters',
    'MOD-05.redundant', 'MOD-17.active-time', 'MOD-17.intervention',
    'MOD-21.first', 'MOD-21.rework', 'MOD-21.stp',
}
SOURCE_PATHS = (
    'agent-eval/tools/comprehensive/invoice_requirements.py',
    'agent-eval/tools/comprehensive/rebuild_cases.py',
    'agent-eval/tools/comprehensive/rebuild_coverage_review.py',
    'agent-eval/tools/comprehensive/rebuild_requirement_links.py',
    'agent-eval/tools/comprehensive/rebuild_scenarios_foundation.py',
    'agent-eval/tools/comprehensive/rebuild_scenarios_history.py',
    'agent-eval/tools/comprehensive/rebuild_scenarios_operations.py',
    'agent-eval/tools/comprehensive/rebuild_scenarios_subagents.py',
    'agent-eval/tests/comprehensive/test_rebuild_coverage_review.py',
)

# Exact requirement identities are authored on the individual checks below and
# then reviewed as a group.  An empty missingConditions list means the group
# decides the complete atomic requirement definition; it still grants no
# product PASS without an eligible real Trial.
EXACT_CONTENT_REVIEWS = {
    'CRIT-3.24-manifest-binding/hash-and-ownership': {
        'accepted': {
            'fresh-config-verified-launch:binding-snapshot-tool-hash',
            'fresh-storage-missing-workspace:admission-allowed',
            'fresh-storage-immutable-artifact-conflict:artifact-current-hash',
        },
        'missingConditions': [
            '尚缺直接以ExecutionManifest产物为对象的文件缺失拒绝检查',
            '尚缺直接以ExecutionManifest实际字节为对象的摘要不符拒绝检查',
            '尚缺ExecutionManifest产物归属与Job Workspace不一致时的专门拒绝检查',
        ],
    },
    'CRIT-3.24-manifest-binding/immutable-run': {
        'accepted': {
            'fresh-config-old-job-new-run-pinned:binding-manifest',
            'fresh-config-old-job-new-run-pinned:history-old-run-hash-unchanged',
            'fresh-config-tool-snapshot-immutable:binding-executed-implementation',
            'fresh-config-tool-snapshot-immutable:snapshot-hash-unchanged',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-manifest-binding/current-controls': {
        'accepted': {
            'fresh-input-withdrawn-old-manifest:read-delivered-bytes',
            'fresh-input-withdrawn-old-manifest:document-current-state',
            'fresh-input-withdrawn-old-manifest:manifest-hash-unchanged',
            'fresh-ops-release-revoked:current-revoke-blocks-existing-run',
            'fresh-ops-release-revoked:same-hash-no-revival',
            'fresh-ops-release-revoked:revoked-dispatch-count',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-input-dataset/immutable-input': {
        'accepted': {
            'fresh-input-valid-multipage-import:document-page-count',
            'fresh-input-valid-multipage-import:publication-hashes-verified',
            'fresh-storage-default-workspace-restart:workspace-id-stable-across-restart',
        },
        'missingConditions': [
            '尚缺在同一输入恢复任务中直接核对不可变数据集manifest版本的检查',
            '尚缺在同一输入恢复任务中把文档、manifest与恢复后Workspace归属联合核对的检查',
        ],
    },
    'CRIT-3.24-input-dataset/missing-or-replaced': {
        'accepted': {
            'fresh-input-valid-multipage-import:publication-hashes-verified',
            'fresh-input-missing-second-page:publication-new-available-versions',
            'fresh-input-missing-second-page:diagnostic-missing-pages',
            'fresh-input-digest-tampered:read-delivered-bytes',
            'fresh-input-digest-tampered:document-current-state',
            'fresh-input-digest-tampered:manifest-stored-hash',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-session-lifecycle/full-recovery': {
        'accepted': {
            'fresh-restore-empty-jsonl:header-roundtrip',
            'fresh-restore-empty-jsonl:tree-tools-cursor-roundtrip',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-session-lifecycle/pagination': {
        'accepted': {
            'fresh-history-pagination-restore:paged-entry-loss-or-duplicates',
            'fresh-history-pagination-restore:restore-loaded-complete-set',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-session-lifecycle/sqlite-authority': {
        'accepted': {
            'fresh-restore-empty-jsonl:header-roundtrip',
            'fresh-restore-empty-jsonl:tree-tools-cursor-roundtrip',
            'fresh-restore-empty-jsonl:jsonl-created',
            'fresh-restore-open-archived:file-recovery-used',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-native-memory/idempotency': {
        'accepted': {
            'fresh-history-id-content-conflict:duplicate-added-rows',
            'fresh-history-id-content-conflict:changed-body-rejected',
            'fresh-history-id-content-conflict:original-entry-and-cursor-unchanged',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-native-memory/tree-and-order': {
        'accepted': {
            'fresh-history-cycle-batch:cyclic-batch-rejected',
            'fresh-history-pagination-restore:paged-entry-loss-or-duplicates',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-native-memory/batch-atomicity': {
        'accepted': {
            'fresh-history-cycle-batch:cyclic-batch-rejected',
            'fresh-history-cycle-batch:inserted-entry-count',
            'fresh-history-dangling-reference:valid-prefix-inserted',
            'fresh-history-dangling-reference:storage-version-unchanged',
        },
        'missingConditions': ['尚缺合法多条新增批次完整提交的正向对照'],
    },
    'CRIT-3.24-native-memory/native-roundtrip': {
        'accepted': {
            'fresh-history-native-records:all-public-mutations-saved',
            'fresh-history-native-records:custom-payload-roundtrip',
            'fresh-history-native-records:native-header-roundtrip',
            'fresh-history-pagination-restore:restore-loaded-complete-set',
            'fresh-history-pagination-restore:restored-cursor',
            'fresh-restore-empty-jsonl:header-roundtrip',
            'fresh-restore-empty-jsonl:tree-tools-cursor-roundtrip',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-persistence-binding/commit-boundary': {
        'accepted': {
            'fresh-memory-sync-public-mutations:label-saved-before-prompt-end',
            'fresh-memory-sync-public-mutations:single-outer-mutation-commit',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-persistence-binding/cursor-version': {
        'accepted': {'fresh-branch-position-only:storage-version-increment'},
        'missingConditions': [],
    },
    'CRIT-3.24-persistence-binding/poison': {
        'accepted': {
            'fresh-memory-storage-outage-poison:new-tool-admissions',
            'fresh-memory-storage-outage-poison:claimed-db-fault-persisted',
        },
        'missingConditions': ['尚缺向实际Pi执行请求abort并观察其受理和停止的直接检查'],
    },
    'CRIT-3.24-persistence-binding/last-committed': {
        'accepted': {
            'fresh-memory-midtransaction-interruption:partial-entry-visible',
            'fresh-memory-midtransaction-interruption:restored-storage-version',
            'fresh-memory-midtransaction-interruption:restored-cursor',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-session-input/request-idempotency': {
        'accepted': {
            'fresh-input-repeat-key:accepted-record-count',
            'fresh-input-key-conflict:conflicting-request-rejected',
            'fresh-input-key-conflict:original-payload-preserved',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-session-input/no-blind-redelivery': {
        'accepted': {
            'fresh-input-unknown-reconcile:blind-redelivery-count',
            'fresh-input-unknown-reconcile:original-input-updated',
        }, 'missingConditions': [],
    },
    'CRIT-3.24.1-context-attribution/request-a-after-b': {
        'accepted': {
            'fresh-snapshot-pointer-race:old-tool-snapshot',
            'fresh-snapshot-pointer-race:current-pointer',
            'fresh-snapshot-pointer-race:request-link-from-adapter',
        }, 'missingConditions': [],
    },
    'CRIT-3.24.1-context-attribution/reject-forged-or-cross-run': {
        'accepted': {
            'fresh-snapshot-forged-model-id:trusted-snapshot',
            'fresh-snapshot-forged-model-id:model-text-used-as-link',
            'fresh-snapshot-forged-model-id:other-snapshot-read',
        }, 'missingConditions': [],
    },
    'CRIT-3.24.1-context-attribution/failed-publication': {
        'accepted': {
            'fresh-snapshot-save-failure:new-input-delivered',
            'fresh-snapshot-save-failure:old-snapshot-content-unchanged',
            'fresh-snapshot-save-failure:old-request-links-unchanged',
        },
        'missingConditions': [
            '尚缺分别证明历史工具、候选记录和RuntimeSnapshot依据均未被失败快照改写的直接字段检查',
        ],
    },
    'CRIT-3.24-child-delegation/pending-first': {
        'accepted': {
            'fresh-sub-read-evidence:native-chain-complete',
            'fresh-sub-read-evidence:binding-before-execution',
            'fresh-sub-slot-replay:origin-retained',
            'fresh-sub-pending-recovery:pending-identity-preserved',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-child-delegation/slot-identity': {
        'accepted': {
            'fresh-sub-slot-replay:same-slot-one-run',
            'fresh-sub-slot-replay:origin-retained',
            'fresh-sub-slots-independent:different-slots-two-runs',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-child-delegation/trusted-binding': {
        'accepted': {
            'fresh-sub-read-evidence:binding-before-execution',
            'fresh-sub-slots-independent:distinct-session-bindings',
            'fresh-sub-slot-out-of-order:slot-mapping-exact',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-child-delegation/failure-retention': {
        'accepted': {
            'fresh-sub-slot-out-of-order:failed-slot-retained',
            'fresh-sub-pending-recovery:pending-identity-preserved',
            'fresh-sub-pending-recovery:no-pending-status-enum',
        }, 'missingConditions': [],
    },
    'CRIT-3.24-child-delegation/no-replay': {
        'accepted': {
            'fresh-sub-read-evidence:required-helper-chosen',
            'fresh-sub-read-evidence:native-chain-complete',
            'fresh-sub-pending-recovery:no-reissued-delegation',
            'fresh-sub-cancel-orphan:recovery-created-child-count',
        }, 'missingConditions': [],
    },
}

# Source-grounded content review of the five exact-line candidate groups.
# These checks establish only named subconditions; none closes its whole
# requirement or grants product/Benchmark acceptance.
CANDIDATE_CONTENT_REVIEWS = {
    'CRIT-4.1-sampling-isolation': {
        'accepted': {
            'fresh-eval-asset-cross-split:cross-split-group-detected',
            'fresh-eval-asset-cross-split:derived-identity-preserved',
            'fresh-eval-asset-exposed:exposed-acceptance-rejected',
            'fresh-eval-asset-exposed:replacement-gap-visible',
            'fresh-eval-asset-valid:valid-source-group-kept',
        },
        'missingConditions': [
            '实际100份Gold及80套业务资料的成员、近重复组和用途划分仍需完成内容审查并冻结',
            '实际衍生资产仍需逐项证明继承同一来源组和用途，不能只依赖设施自检样例',
            '验收暴露记录仍需在后续变更和运行中持续核对，暴露成员不得继续作为未见验收样本',
            '报告仍需区分原票留出与未见模板或供应商测试，不能从当前划分推断后两者已经成立',
        ],
    },
    'CRIT-3.22.3-01': {
        'accepted': {
            'fresh-eval-grade-modes:blocked-request-does-not-erase-a',
        },
        'missingConditions': [
            '同一真实安全Trial还需独立判断实际未授权访问、泄露或写入后果',
            '必须用实际Trace关联三层结论，不能只使用评分器自检投影',
        ],
    },
    'CRIT-4-phased-identities': {
        'accepted': {
            'fresh-eval-trial-assembly-only:assembly-no-fake-trial',
            'fresh-eval-trial-control-closure:control-independent-pins',
            'fresh-eval-trial-crash-register:crash-start-not-duplicated',
            'fresh-eval-trial-independent-k:repeat-distinct-identities',
            'fresh-eval-trial-parallel-isolation:parallel-artifacts-correlated',
            'fresh-eval-trial-resume:resume-same-trial',
            'fresh-eval-trial-single:single-identity-chain',
        },
        'missingConditions': [
            '仍需按P0、P1、P2/P3分别证明最小身份字段与不适用字段没有伪造',
        ],
    },
    'CRIT-4-append-only-lifecycle': {
        'accepted': {
            'fresh-eval-asset-exposed:exposure-change-auditable',
            'fresh-eval-asset-reference-drift:drift-original-preserved',
            'fresh-eval-asset-retired:retired-history-retained',
            'fresh-eval-asset-review-pending:old-review-not-inherited',
            'fresh-eval-asset-version-append:revision-is-append-only',
            'fresh-eval-grade-comparison:comparison-old-results-kept',
            'fresh-eval-grade-dedup:dedup-preserves-prior-report',
        },
        'missingConditions': [
            '尚无一个检查闭合草案、核验、冻结、依赖就绪、执行、评分和复核的完整生命周期',
        ],
    },
    'CRIT-4-gold-authority': {
        'accepted': {
            'fresh-eval-asset-review-pending:pending-gold-blocked',
            'fresh-eval-asset-version-append:revision-not-human-approved',
        },
        'missingConditions': [
            '关系和决策Gold仍需规则及主数据权威性检查',
            '动作Gold仍需对象、金额、供应商、订单和权威回执联合检查',
        ],
    },
}


def _read(snapshot, path):
    return json.loads(snapshot[path].decode('utf-8-sig'))


def _pin(path, raw):
    return {'path': path, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}


def reindex(outputs):
    outputs['manifests/inventory.json'] = json_bytes({'schemaVersion': 3, 'files': [
        _pin(path, raw) for path, raw in sorted(outputs.items())
        if path != 'manifests/inventory.json']})


def _requirement_refs(case):
    locations = [
        ('case.requirementLinks', case.get('requirementLinks')),
        ('case.runtimeRefs', case.get('runtimeRefs')),
        ('episode.initialState.runtimeRefs',
         case.get('episode', {}).get('initialState', {}).get('runtimeRefs')),
    ]
    result = []
    for location, values in locations:
        if not values:
            continue
        if not isinstance(values, list):
            result.append({'id': None, 'location': location, 'raw': values})
            continue
        for value in values:
            identity = value if isinstance(value, str) else (
                value.get('requirementId') or value.get('id') if isinstance(value, dict) else None)
            result.append({'id': identity, 'location': location, 'raw': value})
    return result


def _check_requirement_refs(check):
    values = check.get('requirementRefs') or []
    if not isinstance(values, list):
        return []
    return [value for value in values if isinstance(value, str)]


def build_review_queue(project, requirements, coverage, cases, report):
    """Build candidates for content review without granting requirement coverage.

    Exact identifiers in a check are preserved as explicit candidates. For the
    blocking critical/atomic requirements, an identical specification path and
    source line is also exposed as a discovery aid. A shared source row can
    define multiple atomic requirements, so even this strong-looking match is
    never accepted automatically.
    """
    requirement_ids = {row['id'] for row in requirements['requirements']}
    exact_links = defaultdict(list)
    source_candidates = defaultdict(list)
    priority = {row['id']: row for row in requirements['requirements']
                if row['kind'] in {'critical', 'atomic'}}
    for case in cases:
        for check in case['oracle']['checks']:
            base = {
                'caseId': case['id'], 'caseVersion': case['version'],
                'checkId': check['checkId'], 'module': case['harnessModule'],
                'stage': case['stage'], 'metricId': check['metricId'],
                'evaluationMode': check['evaluationMode'],
            }
            for identity in _check_requirement_refs(check):
                if identity in requirement_ids:
                    exact_links[identity].append({
                        **base, 'matchKind': 'exact_requirement_identifier',
                        'reviewStatus': 'candidate_not_accepted',
                    })
            for source in check.get('sourceRefs') or []:
                path, line = source.get('path'), source.get('startLine')
                if not isinstance(path, str) or not isinstance(line, int):
                    continue
                for identity, requirement in priority.items():
                    required_source = requirement['source']
                    if (path == required_source['path'] and
                            required_source['lineStart'] <= line <= required_source['lineEnd']):
                        source_candidates[identity].append({
                            **base, 'matchKind': 'same_spec_path_and_exact_source_line',
                            'sourcePath': path, 'sourceLine': line,
                            'sourceQuoteSha256': source.get('quoteSha256'),
                            'reviewStatus': 'candidate_not_accepted',
                        })

    def unique(rows):
        result, seen = [], set()
        for row in sorted(rows, key=lambda item: (item['caseId'], item['checkId'])):
            key = (row['caseId'], row['checkId'], row['matchKind'])
            if key not in seen:
                seen.add(key)
                result.append(row)
        return result

    navigation = {row['requirementId']: row['explicitCaseLinks']
                  for row in coverage['requirements']}
    rows = []
    for requirement in requirements['requirements']:
        identity = requirement['id']
        exact = unique(exact_links.get(identity, []))
        anchored = unique(source_candidates.get(identity, []))
        case_links = navigation.get(identity, [])
        if exact:
            mapping_status = 'exact_identifier_candidates_pending_content_review'
        elif anchored:
            mapping_status = 'source_anchor_candidates_pending_content_review'
        elif case_links:
            mapping_status = 'case_navigation_only_check_mapping_pending'
        else:
            mapping_status = 'no_direct_check_candidate_registered'
        candidate_review = CANDIDATE_CONTENT_REVIEWS.get(identity)
        # Older candidate revisions predate authored exact requirementRefs and
        # must remain verifiable long enough to be superseded. Once any exact
        # link for a reviewed requirement exists, the complete registered set
        # is mandatory and drift is rejected below.
        exact_review = EXACT_CONTENT_REVIEWS.get(identity) if exact else None
        if candidate_review and exact_review:
            raise ValueError('Requirement cannot have both source and exact review: ' + identity)
        reviewed_partial = []
        reviewed_direct = []
        review = exact_review or candidate_review
        review_candidates = exact if exact_review else anchored
        if review:
            candidate_ids = {row['checkId'] for row in review_candidates}
            if not review['accepted'] <= candidate_ids:
                raise ValueError('Reviewed requirement candidate disappeared: ' + identity)
            missing_conditions = review['missingConditions']
            full_mapping = bool(exact_review) and not missing_conditions
            for candidate in review_candidates:
                decision = ('accepted_partial_condition'
                            if candidate['checkId'] in review['accepted'] and not full_mapping
                            else 'accepted_direct_condition'
                            if candidate['checkId'] in review['accepted']
                            else 'rejected_not_direct_for_declared_subcondition')
                candidate['contentReviewDecision'] = decision
                if decision.startswith('accepted_'):
                    target = reviewed_direct if full_mapping else reviewed_partial
                    target.append({key: candidate[key] for key in (
                        'caseId', 'caseVersion', 'checkId', 'module', 'stage',
                        'metricId', 'evaluationMode')})
            mapping_status = ('reviewed_direct_check_mapping' if full_mapping else
                              'reviewed_partial_mapping_missing_conditions')
        review_decision = ('reviewed_full_coverage_mapping' if reviewed_direct else
                           'reviewed_partial_coverage' if review else 'pending')
        rows.append({
            'requirementId': identity, 'kind': requirement['kind'],
            'title': requirement['title'], 'source': requirement['source'],
            'reviewPriority': ('blocking_direct_condition' if identity in priority
                               else 'coverage_navigation'),
            'requiredModes': requirement['requiredModes'],
            'firstPhaseMention': requirement.get('firstPhaseMention'),
            'exactIdentifierCheckLinks': exact,
            'sourceAnchorCandidates': anchored,
            'caseNavigationLinks': case_links,
            'mappingStatus': mapping_status,
            'reviewDecision': review_decision,
            **({'reviewedDirectCheckLinks': reviewed_direct} if reviewed_direct else {}),
            **({'reviewedPartialCheckLinks': reviewed_partial,
                'missingConditions': review['missingConditions'],
                'contentReview': {
                    'performedBy': 'codex_agent_contract_review',
                    'performedAt': '2026-09-19',
                    'method': 'source_requirement_assertion_evidence_and_scope_review',
                    'humanReview': False,
                    'fullRequirementCoverageGranted': bool(reviewed_direct),
                }} if review else {}),
            'acceptanceStatus': 'not_evaluated',
        })
    anchored_rows = [row for row in rows if row['sourceAnchorCandidates']]
    exact_count = sum(len(row['exactIdentifierCheckLinks']) for row in rows)
    anchored_count = sum(len(row['sourceAnchorCandidates']) for row in rows)
    reviewed_candidates = sum(
        candidate.get('contentReviewDecision') is not None
        for row in rows for candidate in row['sourceAnchorCandidates'])
    reviewed_exact = sum(
        candidate.get('contentReviewDecision') is not None
        for row in rows for candidate in row['exactIdentifierCheckLinks'])
    accepted_partial = sum(len(row.get('reviewedPartialCheckLinks', [])) for row in rows)
    accepted_direct = sum(len(row.get('reviewedDirectCheckLinks', [])) for row in rows)
    return {
        'schemaVersion': 1,
        'status': 'candidate_requirement_check_links_content_review_pending',
        'purpose': (
            '逐条审查主方案要求与具体Case/checkId的直接关系；候选关系只帮助定位，'
            '未经过内容审查不得计作覆盖或通过。'),
        'generationRules': [
            'Only an exact registered requirement identifier in a check is an identifier candidate.',
            'Critical/atomic source candidates require the same specification path and exact source line.',
            'Source, module, stage, title or metric similarity never grants coverage automatically.',
            'A reviewer must confirm that the check assertion and evidence directly decide the requirement condition.',
            'A reviewed mapping still does not grant product PASS without an actual eligible Trial.',
        ],
        'counts': {
            'requirements': len(rows),
            'blockingPriorityRequirements': len(priority),
            'reviewedRequirementMappings': sum(
                row['reviewDecision'] == 'reviewed_full_coverage_mapping' for row in rows),
            'partiallyReviewedRequirementMappings': sum(
                row['reviewDecision'] == 'reviewed_partial_coverage' for row in rows),
            'exactIdentifierCheckLinks': exact_count,
            'sourceAnchorCandidateRequirements': len(anchored_rows),
            'sourceAnchorCandidateChecks': anchored_count,
            'reviewedSourceCandidateChecks': reviewed_candidates,
            'acceptedPartialCheckLinks': accepted_partial,
            **({'reviewedExactCandidateChecks': reviewed_exact,
                'acceptedDirectCheckLinks': accepted_direct}
               if reviewed_exact or accepted_direct else {}),
            'sourcePlanConflicts': sum('sourcePlanConflict' in row for row in rows),
            'requirementsWithoutCandidate': sum(
                not row['exactIdentifierCheckLinks'] and not row['sourceAnchorCandidates']
                and not row['caseNavigationLinks'] for row in rows),
        },
        'reviewInstructions': {
            'acceptOnlyWhen': [
                '检查断言直接判断该要求的具体条件',
                '证据要求能够区分正确、错误和缺证据',
                'Case初态与触发能真实构造该条件',
                '需要拒绝、去重或权限控制时存在适用的合法对照',
            ],
            'rejectWhen': [
                '仅模块、阶段、标题、指标或同一来源行相似',
                '检查只证明相关但更窄或不同的条件',
                '需要真实SDK、产品状态或业务结果但只有合成声明',
            ],
            'acceptedMappingEffect': (
                '只允许将该要求登记为已有直接检查；实际产品运行与验收状态仍单独计算。'),
        },
        'requirements': rows,
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def build_inventory(project, snapshot):
    from invoice_requirements import load_requirements
    from rebuild_contracts import load_spec_contracts
    requirements = load_requirements(project)
    contracts = load_spec_contracts(project)
    if requirements.get('unregisteredPassages'):
        raise ValueError('Requirement extraction left unregistered passages')
    expected_counts = {'DrivingTask': 14, 'MOD': 31, 'critical': 95,
                       'RT': 17, 'RTC': 90, 'RTX': 6, 'atomic': 77}
    actual_counts = dict(Counter(row['kind'] for row in requirements['requirements']))
    if actual_counts != expected_counts or len(requirements['requirements']) != 330:
        raise ValueError('Current requirement inventory count differs')
    requirement_ids = {row['id'] for row in requirements['requirements']}
    if len(requirement_ids) != 330:
        raise ValueError('Duplicate requirement identity')
    cases = [_read(snapshot, path) for path in sorted(snapshot) if path.startswith('cases/')]
    if len(cases) != 548:
        raise ValueError('Coverage inventory requires all 548 Cases')
    metric_checks, explicit, invalid = defaultdict(list), defaultdict(list), []
    modules, stages, check_count = Counter(), Counter(), 0
    for case in cases:
        modules[case['harnessModule']] += 1
        stages[case['stage']] += 1
        for check in case['oracle']['checks']:
            check_count += 1
            metric_id = check['metricId']
            if metric_id not in contracts['metrics']:
                raise ValueError('Unknown metric in current Case: ' + metric_id)
            metric_checks[metric_id].append({
                'caseId': case['id'], 'caseVersion': case['version'],
                'checkId': check['checkId'], 'module': case['harnessModule'],
                'stage': case['stage'], 'evaluationMode': check['evaluationMode'],
            })
        for ref in _requirement_refs(case):
            record = {'caseId': case['id'], 'caseVersion': case['version'],
                      'module': case['harnessModule'], 'location': ref['location']}
            if ref['id'] in requirement_ids:
                explicit[ref['id']].append(record)
            else:
                invalid.append({'reference': ref['id'], **record})
    all_metrics = set(contracts['metrics'])
    unreferenced = all_metrics - set(metric_checks)
    if unreferenced != DERIVED_REPORT_METRICS:
        raise ValueError('Unreferenced metric classification changed')
    direct_metrics = []
    for metric_id in sorted(metric_checks):
        definition = contracts['metrics'][metric_id]
        direct_metrics.append({
            'metricId': metric_id,
            'metricVersionRef': canonical_digest(definition['definition']),
            'definition': definition['definition'],
            'checkCount': len(metric_checks[metric_id]),
            'caseCount': len({row['caseId'] for row in metric_checks[metric_id]}),
            'checks': metric_checks[metric_id],
            'meaning': 'direct_case_check_for_declared_condition_not_complete_module_coverage',
        })
    derived_metrics = [{
        'metricId': metric_id,
        'metricVersionRef': canonical_digest(contracts['metrics'][metric_id]['definition']),
        'definition': contracts['metrics'][metric_id]['definition'],
        'status': 'requires_trial_level_or_report_aggregation',
        'directCaseGap': False,
    } for metric_id in sorted(DERIVED_REPORT_METRICS)]
    requirement_rows = []
    for requirement in requirements['requirements']:
        links = sorted(explicit.get(requirement['id'], []), key=lambda row: row['caseId'])
        requirement_rows.append({
            'requirementId': requirement['id'], 'kind': requirement['kind'],
            'title': requirement['title'], 'firstPhaseMention': requirement.get('firstPhaseMention'),
            'requiredModes': requirement['requiredModes'], 'source': requirement['source'],
            'explicitCaseLinks': links,
            'coverageStatus': ('explicit_reference_present_check_mapping_pending' if links
                               else 'no_explicit_case_requirement_link'),
            'actualProductRuns': 0, 'acceptanceStatus': 'not_evaluated',
        })
    by_kind_linked = Counter(row['kind'] for row in requirements['requirements']
                             if explicit.get(row['id']))
    atomic_unlinked = sum(row['kind'] == 'atomic' and not explicit.get(row['id'])
                          for row in requirements['requirements'])
    critical_unlinked = sum(row['kind'] == 'critical' and not explicit.get(row['id'])
                            for row in requirements['requirements'])
    known_gaps = [
        {'id': 'atomic_and_critical_direct_links',
         'detail': (f'{critical_unlinked} critical and {atomic_unlinked} atomic requirements '
                    'have no explicit reviewed Case/checkId link.')},
        {'id': 'explicit_link_check_mapping',
         'detail': (f'{len(explicit)} exact requirement identities have Case-level navigation '
                    'links; none is yet bound to reviewed checkIds.')},
        {'id': 'content_review_and_execution',
         'detail': 'All requirement acceptance statuses remain not_evaluated; actual product runs are zero.'},
    ]
    if invalid:
        invalid_ids = ', '.join(sorted({str(row['reference']) for row in invalid}))
        known_gaps.insert(1, {
            'id': 'invalid_or_broad_requirement_references',
            'detail': f'{len(invalid)} invalid or broad requirement references remain: {invalid_ids}.'})
    coverage = {
        'schemaVersion': 3,
        'status': 'explicit_links_and_metric_inventory_content_review_pending',
        'interpretation': (
            'Metric checks prove only their declared Case conditions. Exact RT/RTC links are '
            'navigation evidence until checkIds are reviewed; module, stage, quote similarity '
            'and file counts never imply requirement coverage.'),
        'sourceHashes': requirements['sourceHashes'],
        'caseCatalogRef': _pin('manifests/case-catalog.json',
                               snapshot['manifests/case-catalog.json']),
        'counts': {
            'requirements': 330, 'requirementsByKind': expected_counts,
            'explicitlyLinkedRequirements': len(explicit),
            'explicitlyLinkedRequirementsByKind': dict(by_kind_linked),
            'requirementsWithoutExplicitLinks': 330 - len(explicit),
            'invalidOrBroadRequirementReferences': len(invalid),
            'cases': len(cases), 'checks': check_count,
            'definedMetrics': len(all_metrics), 'directCheckMetrics': len(metric_checks),
            'derivedReportMetrics': len(DERIVED_REPORT_METRICS),
            'actualProductRuns': 0,
        },
        'moduleCaseCounts': dict(sorted(modules.items())),
        'stageCaseCounts': dict(sorted(stages.items(), key=lambda item: int(item[0][1:]))),
        'directMetricCoverage': direct_metrics,
        'derivedReportMetrics': derived_metrics,
        'requirements': requirement_rows,
        'invalidOrBroadRequirementReferences': sorted(
            invalid, key=lambda row: (str(row['reference']), row['caseId'])),
        'knownGaps': known_gaps,
        'countIsCoverageProof': False,
        'contentReview': 'pending', 'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }
    report = _read(snapshot, 'manifests/preparation-report.json')
    review_queue = build_review_queue(project, requirements, coverage, cases, report)
    queue_by_id = {row['requirementId']: row for row in review_queue['requirements']}
    for row in coverage['requirements']:
        reviewed = queue_by_id[row['requirementId']]
        if reviewed.get('reviewedDirectCheckLinks'):
            row['reviewedDirectCheckLinks'] = reviewed['reviewedDirectCheckLinks']
            row['coverageStatus'] = 'reviewed_direct_check_mapping'
        if reviewed.get('reviewedPartialCheckLinks'):
            row['reviewedPartialCheckLinks'] = reviewed['reviewedPartialCheckLinks']
            row['missingConditions'] = reviewed['missingConditions']
            row['coverageStatus'] = 'reviewed_partial_check_mapping_missing_conditions'
        if reviewed.get('sourcePlanConflict'):
            row['sourcePlanConflict'] = reviewed['sourcePlanConflict']
            row['coverageStatus'] = 'blocked_source_plan_conflict'
    coverage['requirementReviewQueueRef'] = _pin(REVIEW_QUEUE, json_bytes(review_queue))
    coverage['counts']['reviewedRequirementMappings'] = (
        review_queue['counts']['reviewedRequirementMappings'])
    coverage['counts']['partiallyReviewedRequirementMappings'] = (
        review_queue['counts']['partiallyReviewedRequirementMappings'])
    coverage['counts']['sourceAnchorCandidateRequirements'] = (
        review_queue['counts']['sourceAnchorCandidateRequirements'])
    coverage['counts']['sourceAnchorCandidateChecks'] = (
        review_queue['counts']['sourceAnchorCandidateChecks'])
    coverage['counts']['reviewedSourceCandidateChecks'] = (
        review_queue['counts']['reviewedSourceCandidateChecks'])
    if 'reviewedExactCandidateChecks' in review_queue['counts']:
        coverage['counts']['reviewedExactCandidateChecks'] = (
            review_queue['counts']['reviewedExactCandidateChecks'])
    coverage['counts']['acceptedPartialCheckLinks'] = (
        review_queue['counts']['acceptedPartialCheckLinks'])
    if 'acceptedDirectCheckLinks' in review_queue['counts']:
        coverage['counts']['acceptedDirectCheckLinks'] = (
            review_queue['counts']['acceptedDirectCheckLinks'])
    coverage['counts']['sourcePlanConflicts'] = review_queue['counts']['sourcePlanConflicts']
    remaining_by_kind = {
        kind: sum(row['kind'] == kind and row['reviewDecision'] != 'reviewed_full_coverage_mapping'
                  for row in review_queue['requirements'])
        for kind in ('critical', 'atomic')
    }
    for gap in coverage['knownGaps']:
        if gap['id'] == 'atomic_and_critical_direct_links':
            gap['detail'] = (
                f'{remaining_by_kind["critical"]} critical and {remaining_by_kind["atomic"]} '
                'requirements still lack a full reviewed Case/checkId mapping.')
        elif gap['id'] == 'explicit_link_check_mapping':
            gap['detail'] = (
                f'{review_queue["counts"]["reviewedRequirementMappings"]} requirements have a '
                'full reviewed checkId mapping; remaining exact links are pending or partial.')
    candidate_review_receipt = build_candidate_review_receipt(project, review_queue)
    coverage['candidateContentReviewRef'] = _pin(
        CANDIDATE_REVIEW_RECEIPT, json_bytes(candidate_review_receipt))
    return requirements, coverage, review_queue, candidate_review_receipt


def build_candidate_review_receipt(project, queue):
    rows = [row for row in queue['requirements']
            if row['reviewDecision'] in {
                'reviewed_partial_coverage', 'reviewed_full_coverage_mapping'}]
    has_direct = bool(queue['counts'].get('reviewedExactCandidateChecks'))
    return {
        'schemaVersion': 1,
        'reviewId': 'exact-source-candidate-content-review-2026-09-19',
        'status': ('REQUIREMENT_CHECK_MAPPINGS_REVIEWED_NO_PRODUCT_PASS' if has_direct else
                   'PARTIAL_REQUIREMENT_CONDITIONS_REVIEWED_NO_FULL_COVERAGE'),
        'performedBy': 'codex_agent_contract_review',
        'performedAt': '2026-09-19',
        'humanReview': False,
        'method': 'source_requirement_assertion_evidence_and_scope_review',
        'requirementReviewQueueRef': _pin(REVIEW_QUEUE, json_bytes(queue)),
        'reviewedRequirements': [{
            'requirementId': row['requirementId'],
            'decision': row['reviewDecision'],
            **({'acceptedDirectCheckIds': [link['checkId']
                                           for link in row.get('reviewedDirectCheckLinks', [])]}
               if has_direct else {}),
            'acceptedPartialCheckIds': [link['checkId']
                                        for link in row.get('reviewedPartialCheckLinks', [])],
            'missingConditions': row.get('missingConditions', []),
            'sourcePlanConflict': row.get('sourcePlanConflict'),
        } for row in rows],
        'counts': {
            'requirementsReviewed': len(rows),
            'partialRequirements': sum(
                row['reviewDecision'] == 'reviewed_partial_coverage' for row in rows),
            'fullyMappedRequirements': sum(
                row['reviewDecision'] == 'reviewed_full_coverage_mapping' for row in rows),
            'sourcePlanConflicts': sum(
                row['reviewDecision'] == 'blocked_source_plan_conflict' for row in rows),
            'candidateChecksReviewed': queue['counts']['reviewedSourceCandidateChecks'],
            'acceptedPartialCheckLinks': queue['counts']['acceptedPartialCheckLinks'],
            **({'exactIdentifierChecksReviewed': queue['counts']['reviewedExactCandidateChecks'],
                'acceptedDirectCheckLinks': queue['counts']['acceptedDirectCheckLinks']}
               if has_direct else {}),
        },
        'sourcePins': [file_pin(project, path) for path in SOURCE_PATHS],
        'notClaimed': [('complete_all_requirement_coverage' if has_direct else
                        'full_requirement_coverage'), 'human_content_review',
                       'product_execution', 'benchmark_pass', 'formal_acceptance'],
        'actualProductRuns': 0,
        'formalAcceptanceEligible': False,
    }


def build_receipt(project, snapshot):
    return {
        'schemaVersion': 1, 'reviewId': 'current-source-requirement-and-metric-inventory',
        'status': 'REPLAYABLE_GAP_INVENTORY_AVAILABLE',
        'scope': ['requirements_source_inventory', 'exact_case_requirement_references',
                  'direct_metric_checks', 'derived_report_metric_classification',
                  'requirement_check_review_queue'],
        'notClaimed': ['atomic_requirement_coverage_complete', 'content_review',
                       'actual_product_run', 'benchmark_pass', 'formal_acceptance'],
        'requirementsRef': _pin(REQUIREMENTS, snapshot[REQUIREMENTS]),
        'coverageRef': _pin(COVERAGE, snapshot[COVERAGE]),
        'requirementReviewQueueRef': _pin(REVIEW_QUEUE, snapshot[REVIEW_QUEUE]),
        'candidateContentReviewRef': _pin(
            CANDIDATE_REVIEW_RECEIPT, snapshot[CANDIDATE_REVIEW_RECEIPT]),
        'caseCatalogRef': _pin('manifests/case-catalog.json', snapshot['manifests/case-catalog.json']),
        'sourcePins': [file_pin(project, path) for path in SOURCE_PATHS],
        'actualProductRuns': 0, 'formalAcceptanceEligible': False,
    }


def _refresh_benchmarks(project, outputs):
    from rebuild_benchmarks import PREFIX, build_bundle
    reindex(outputs)
    bundle = build_bundle(project, outputs)
    outputs = {path: raw for path, raw in outputs.items() if not path.startswith(PREFIX)}
    outputs.update(bundle)
    index = _read(outputs, PREFIX + 'index.json')
    views = _read(outputs, 'manifests/views.json')
    views['benchmarks'] = {row['benchmarkId']: {'membersRef': row['membersRef'],
        'selection': 'direct_members_only', 'counts': row['counts']} for row in index['benchmarks']}
    outputs['manifests/views.json'] = json_bytes(views)
    report = _read(outputs, 'manifests/preparation-report.json')
    report['benchmarks'] = {'preparedDefinitions': 11,
        'indexRef': _pin(PREFIX + 'index.json', outputs[PREFIX + 'index.json']),
        'membershipReview': 'pending', 'freeze': 'not_frozen',
        'actualProductRuns': 0, 'baselineCount': 0}
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    reindex(outputs)
    return outputs


def build_revision(project, snapshot):
    verify_inventory(snapshot)
    requirements, coverage, review_queue, candidate_review_receipt = build_inventory(project, snapshot)
    outputs = dict(snapshot)
    outputs[REQUIREMENTS] = json_bytes(requirements)
    outputs[COVERAGE] = json_bytes(coverage)
    outputs[REVIEW_QUEUE] = json_bytes(review_queue)
    outputs[CANDIDATE_REVIEW_RECEIPT] = json_bytes(candidate_review_receipt)
    outputs[RECEIPT] = json_bytes(build_receipt(project, outputs))
    readiness = _read(outputs, 'manifests/readiness.json')
    blocker_renames = {
        'new_source_conditions': 'requirement_condition_content_review',
        'benchmark_integration': 'benchmark_content_and_freeze_review',
        'publication': 'formal_release_freeze_and_baseline',
    }
    for item in readiness['blockers']:
        item['id'] = blocker_renames.get(item['id'], item['id'])
    blockers = {item['id']: item for item in readiness['blockers']}
    if 'requirement_condition_content_review' not in blockers:
        raise ValueError('Expected source-condition blocker is missing')
    counts = coverage['counts']
    reviewed_gold = sum(
        _read(outputs, path).get('humanVerified') is True
        for path in outputs if path.startswith('gold/'))
    if reviewed_gold == 100:
        readiness['blockers'] = [item for item in readiness['blockers']
                                 if item['id'] != 'gold_annotation_and_human_review']
        blockers.pop('gold_annotation_and_human_review', None)
    elif 'gold_annotation_and_human_review' in blockers:
        blockers['gold_annotation_and_human_review']['detail'] = (
            f'{reviewed_gold}/100 Gold candidates have an accepted human review bound to '
            'the exact current Gold and original image; the remaining reviews are pending.')
    unlinked = {row['kind']: sum(item['kind'] == row['kind'] and
                                 item.get('coverageStatus') != 'reviewed_direct_check_mapping'
                                 for item in coverage['requirements'])
                for row in coverage['requirements'] if row['kind'] in {'critical', 'atomic'}}
    blockers['requirement_condition_content_review']['detail'] = (
        f'330 requirements are registered. {counts["directCheckMetrics"]}/'
        f'{counts["definedMetrics"]} metrics have direct Case checks; '
        f'{counts["derivedReportMetrics"]} are classified report-derived. '
        f'{counts["explicitlyLinkedRequirements"]} exact requirement identities have '
        f'Case-level navigation links, {counts["invalidOrBroadRequirementReferences"]} '
        'invalid or broad requirement references remain, and '
        f'{unlinked.get("critical", 0)} critical plus {unlinked.get("atomic", 0)} atomic '
        'requirements lack reviewed Case/checkId links. '
        f'{counts["sourceAnchorCandidateChecks"]} exact-source-line candidates across '
        f'{counts["sourceAnchorCandidateRequirements"]} requirements were content-reviewed: '
        f'{counts["acceptedPartialCheckLinks"]} checks support partial conditions across '
        f'{counts["partiallyReviewedRequirementMappings"]} requirements; '
        f'{counts.get("acceptedDirectCheckLinks", 0)} exact-identifier checks fully map '
        f'{counts["reviewedRequirementMappings"]} atomic requirements. The current specification and active dataset '
        f'budget have {counts["sourcePlanConflicts"]} source-plan conflicts.')
    if 'benchmark_content_and_freeze_review' in blockers:
        blockers['benchmark_content_and_freeze_review']['detail'] = (
            'Eleven Benchmark bundles are assembled from direct checks; requirement inventory '
            'and metric coverage are replayable, while atomic check mapping and content review remain pending.')
    if 'formal_release_freeze_and_baseline' in blockers:
        blockers['formal_release_freeze_and_baseline']['detail'] = (
            'The current work-in-progress materials are installed under agent-eval/data. '
            'Formal release freeze and a product-evidence Baseline remain pending.')
    readiness['assembly'] = 'materials_built_work_in_progress'
    readiness['blockers'] = [blockers[item['id']] for item in readiness['blockers']]
    readiness['sourceCoverageInventory'] = {
        'status': 'REPLAYABLE_GAP_INVENTORY_AVAILABLE_CONTENT_REVIEW_PENDING',
        'requirements': counts['requirements'],
        'directCheckMetrics': counts['directCheckMetrics'],
        'derivedReportMetrics': counts['derivedReportMetrics'],
        'explicitlyLinkedRequirements': counts['explicitlyLinkedRequirements'],
        'invalidOrBroadReferences': counts['invalidOrBroadRequirementReferences'],
        'reviewedRequirementMappings': counts['reviewedRequirementMappings'],
        'partiallyReviewedRequirementMappings': counts['partiallyReviewedRequirementMappings'],
        'sourceAnchorCandidateRequirements': counts['sourceAnchorCandidateRequirements'],
        'sourceAnchorCandidateChecks': counts['sourceAnchorCandidateChecks'],
        'reviewedSourceCandidateChecks': counts['reviewedSourceCandidateChecks'],
        'reviewedExactCandidateChecks': counts.get('reviewedExactCandidateChecks', 0),
        'acceptedPartialCheckLinks': counts['acceptedPartialCheckLinks'],
        'acceptedDirectCheckLinks': counts.get('acceptedDirectCheckLinks', 0),
        'sourcePlanConflicts': counts['sourcePlanConflicts'],
        'requirementsRef': _pin(REQUIREMENTS, outputs[REQUIREMENTS]),
        'coverageRef': _pin(COVERAGE, outputs[COVERAGE]),
        'requirementReviewQueueRef': _pin(REVIEW_QUEUE, outputs[REVIEW_QUEUE]),
        'candidateContentReviewRef': _pin(
            CANDIDATE_REVIEW_RECEIPT, outputs[CANDIDATE_REVIEW_RECEIPT]),
        'receiptRef': _pin(RECEIPT, outputs[RECEIPT]),
    }
    outputs['manifests/readiness.json'] = json_bytes(readiness)
    report = _read(outputs, 'manifests/preparation-report.json')
    report['status'] = 'full_material_budget_content_review_pending'
    report['remainingWork'] = [item['id'] for item in readiness['blockers']]
    report['requirementsCoverage'] = deepcopy(readiness['sourceCoverageInventory'])
    outputs['manifests/preparation-report.json'] = json_bytes(report)
    outputs = _refresh_benchmarks(project, outputs)
    reindex(outputs)
    validate_snapshot(project, outputs)
    return outputs


def validate_snapshot(project, snapshot):
    present = [path in snapshot for path in (
        REQUIREMENTS, COVERAGE, REVIEW_QUEUE, CANDIDATE_REVIEW_RECEIPT, RECEIPT)]
    if not any(present):
        return
    if not all(present):
        raise ValueError('Coverage inventory assets must be published atomically')
    requirements, coverage, review_queue, candidate_review_receipt = build_inventory(project, snapshot)
    if (snapshot[REQUIREMENTS] != json_bytes(requirements) or
            snapshot[COVERAGE] != json_bytes(coverage) or
            snapshot[REVIEW_QUEUE] != json_bytes(review_queue) or
            snapshot[CANDIDATE_REVIEW_RECEIPT] != json_bytes(candidate_review_receipt)):
        raise ValueError('Requirement or coverage inventory is not replayable')
    receipt = _read(snapshot, RECEIPT)
    if receipt != build_receipt(project, snapshot):
        raise ValueError('Coverage inventory receipt is not replayable')
    readiness = _read(snapshot, 'manifests/readiness.json')
    ref = readiness.get('sourceCoverageInventory', {})
    if (ref.get('requirementsRef') != _pin(REQUIREMENTS, snapshot[REQUIREMENTS]) or
            ref.get('coverageRef') != _pin(COVERAGE, snapshot[COVERAGE]) or
            ref.get('requirementReviewQueueRef') != _pin(REVIEW_QUEUE, snapshot[REVIEW_QUEUE]) or
            ref.get('candidateContentReviewRef') != _pin(
                CANDIDATE_REVIEW_RECEIPT, snapshot[CANDIDATE_REVIEW_RECEIPT]) or
            ref.get('receiptRef') != _pin(RECEIPT, snapshot[RECEIPT]) or
            ref.get('status') != 'REPLAYABLE_GAP_INVENTORY_AVAILABLE_CONTENT_REVIEW_PENDING'):
        raise ValueError('Coverage readiness projection differs')
    if _read(snapshot, 'manifests/preparation-report.json').get('requirementsCoverage') != ref:
        raise ValueError('Coverage preparation projection differs')


def release(project):
    from rebuild_dataset import verify_asset_snapshot
    from rebuild_case_release import verify_case_files
    from rebuild_contracts import load_spec_contracts
    from rebuild_staging import candidate_lock, revise_candidate
    project = Path(project).resolve()
    with candidate_lock(project):
        snapshot = read_candidate(project)
        # This operation is the controlled successor of the coverage receipt,
        # so the prior receipt legitimately pins the previous bytes of this
        # tool and its regression test. Validate every other current contract
        # and the complete Case catalog, then replace coverage atomically.
        verify_inventory(snapshot)
        verify_case_files(snapshot, load_spec_contracts(project))
        from rebuild_spec_binding import validate_snapshot as validate_spec_binding
        from rebuild_source_revision import validate_receipt as validate_source_receipt
        from rebuild_actions_review import validate_snapshot as validate_actions_review
        from rebuild_actions_semantic_review import validate_snapshot as validate_actions_semantic_review
        from rebuild_actions_common_review import validate_snapshot as validate_actions_common_review
        from rebuild_actions_state_review import validate_snapshot as validate_actions_state_review
        from rebuild_actions_effect_review import validate_snapshot as validate_actions_effect_review
        from rebuild_actions_payload_review import validate_snapshot as validate_actions_payload_review
        from rebuild_actions_recovery_review import validate_snapshot as validate_actions_recovery_review
        from rebuild_actions_presentation_review import validate_snapshot as validate_actions_presentation_review
        from rebuild_runtime_evidence_review import validate_snapshot as validate_runtime_evidence_review
        from rebuild_grader_review import validate_snapshot as validate_grader_review
        validate_spec_binding(project, snapshot)
        validate_source_receipt(snapshot)
        validate_actions_review(project, snapshot)
        validate_actions_semantic_review(project, snapshot)
        validate_actions_common_review(project, snapshot)
        validate_actions_state_review(project, snapshot)
        validate_actions_effect_review(project, snapshot)
        validate_actions_payload_review(project, snapshot)
        validate_actions_recovery_review(project, snapshot)
        validate_actions_presentation_review(project, snapshot)
        validate_runtime_evidence_review(project, snapshot)
        validate_grader_review(project, snapshot)
    outputs = build_revision(project, snapshot)
    verify_asset_snapshot(project, outputs)
    result = revise_candidate(project, snapshot, outputs)
    result.update(candidateSha256=snapshot_digest(outputs), requirements=330,
                  directCheckMetrics=93, derivedReportMetrics=28,
                  actualProductRuns=0, formalAcceptanceEligible=False)
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parents[3])
    args = parser.parse_args()
    print(json.dumps(release(args.project), ensure_ascii=False, indent=2))
