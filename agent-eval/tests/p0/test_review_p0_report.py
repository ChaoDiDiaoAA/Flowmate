import hashlib
import json
import sys
import pytest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools" / "p0"
sys.path.insert(0, str(TOOLS))

from review_p0_report import review_p0_report  # noqa: E402


def _write(path: Path, value: object) -> tuple[str, int]:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    path.write_bytes(raw)
    return hashlib.sha256(raw).hexdigest(), len(raw)


def _fixture(tmp_path: Path) -> tuple[Path, Path, Path, Path]:
    root = tmp_path / "evidence"
    root.mkdir()
    facts = {"ok": True, "count": 2}
    digest, size = _write(root / "facts.json", facts)
    report = {
        "schemaVersion": "p0-f-evidence/v1",
        "phase": "P0",
        "evidenceKind": "F",
        "scope": "product",
        "binding": {"codeCommit": "abc"},
        "files": [{"path": "facts.json", "sha256": digest, "bytes": size, "kind": "facts"}],
        "checks": [{
            "checkId": "P0-F01/test/v1",
            "caseVariantId": "normal",
            "required": True,
            "applicable": True,
            "status": "PASS",
            "evidencePaths": ["facts.json"],
        }],
    }
    report_path = tmp_path / "report.json"
    report_path.write_text(json.dumps(report), encoding="utf-8")
    expected_path = tmp_path / "expected.json"
    expected_path.write_text(json.dumps({"codeCommit": "abc"}), encoding="utf-8")
    frozen_path = tmp_path / "frozen.json"
    frozen_path.write_text(json.dumps({
        "checks": [{
            "checkId": "P0-F01/test/v1",
            "caseVariantId": "normal",
            "required": True,
            "applicable": True,
            "requiredStatus": "PASS",
            "evidencePaths": ["facts.json"],
            "assertions": [
                {"path": "facts.json", "pointer": "/ok", "equals": True},
                {"path": "facts.json", "pointer": "/count", "equals": 2},
            ],
        }],
    }), encoding="utf-8")
    return report_path, root, expected_path, frozen_path


def test_review_accepts_a_bound_report(tmp_path: Path) -> None:
    report, root, expected, frozen = _fixture(tmp_path)
    result = review_p0_report(report, root, expected, frozen)
    assert result["status"] == "PASS"
    assert result["bindingMatch"] is True
    assert result["checks"][0]["status"] == "PASS"


def test_review_does_not_accept_tampered_evidence(tmp_path: Path) -> None:
    report, root, expected, frozen = _fixture(tmp_path)
    (root / "facts.json").write_text('{"ok":false,"count":2}', encoding="utf-8")
    result = review_p0_report(report, root, expected, frozen)
    assert result["status"] == "ERROR"
    assert any("digest mismatch" in item for item in result["problems"])


def test_review_marks_missing_assertion_unjudgeable(tmp_path: Path) -> None:
    report, root, expected, frozen = _fixture(tmp_path)
    frozen_data = json.loads(frozen.read_text(encoding="utf-8"))
    frozen_data["checks"][0]["assertions"][0]["equals"] = False
    frozen.write_text(json.dumps(frozen_data), encoding="utf-8")
    result = review_p0_report(report, root, expected, frozen)
    assert result["status"] == "UNJUDGEABLE"
    assert result["checks"][0]["status"] == "UNJUDGEABLE"


def test_review_rejects_an_unsafe_evidence_path(tmp_path: Path) -> None:
    report, root, expected, frozen = _fixture(tmp_path)
    report_data = json.loads(report.read_text(encoding="utf-8"))
    report_data["files"][0]["path"] = "../facts.json"
    report.write_text(json.dumps(report_data), encoding="utf-8")
    result = review_p0_report(report, root, expected, frozen)
    assert result["status"] == "ERROR"
    assert any("traversal" in item for item in result["problems"])


_ABSENT = object()


def _stage_fixture(tmp_path, *, fact=True, include=True, use=True, policy=_ABSENT, purpose="development"):
    report, root, expected, frozen = _fixture(tmp_path)
    cases = {'schemaVersion': 'p0-stage-cases/v1', 'stage': 'P0', 'version': 1,
             'cases': [{'id': 'P0-F01', 'scope': 'product', 'required': True,
                        'oracle': {'assertions': [{'path': 'facts.json', 'pointer': '/ok', 'equals': True}]}}]}
    case_hash, _ = _write(frozen, cases)
    oracle = json.dumps([{'id': c['id'], 'oracle': c['oracle']} for c in cases['cases']], ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    binding = {'codeCommit': 'synthetic-only', 'caseSetSha256': case_hash,
               'oracleSha256': hashlib.sha256(oracle).hexdigest(), 'purpose': purpose, 'inputManifestSha256': 'a' * 64}
    if policy is not _ABSENT:
        binding['assessmentPolicy'] = policy
    binding_hash, _ = _write(expected, binding)
    files = []
    for name, value in [('facts.json', {'ok': fact}), ('execution-freeze.json', {
        'schemaVersion': 'p0-freeze/v1', 'expectedBindingSha256': binding_hash, 'frozenAt': '2026-09-20T00:00:00Z'}),
        ('execution-steps.json', {'expectedBindingSha256': binding_hash, 'outputs': {}})]:
        digest, size = _write(root / name, value)
        if name != 'facts.json' or include:
            files.append({'path': name, 'sha256': digest, 'bytes': size, 'kind': 'facts'})
    data = json.loads(report.read_text())
    data.update(binding=binding, files=files, blockers=[])
    _write(report, data)
    if use:
        _write(root / 'source-use.json', {'purpose': 'development', 'sourceManifestSha256': 'a' * 64,
            'confirmedForPurpose': True, 'basis': 'SYNTHETIC SELF-TEST ONLY', 'recordedBy': 'synthetic fixture', 'recordedAt': '2026-09-20T00:00:00Z'})
    return report, root, expected, frozen


def test_stage_review_normal_and_product_failure(tmp_path):
    good = tmp_path / 'good'; good.mkdir()
    report, root, expected, frozen = _stage_fixture(good)
    assert review_p0_report(report, root, expected, frozen)['status'] == 'PASS'
    bad = tmp_path / 'bad'; bad.mkdir()
    args = _stage_fixture(bad, fact=False)
    assert review_p0_report(*args)['status'] == 'FAIL'


def test_stage_review_missing_and_actual_use_blocker(tmp_path):
    absent = tmp_path / 'absent'; absent.mkdir()
    assert review_p0_report(*_stage_fixture(absent, include=False))['status'] == 'UNJUDGEABLE'
    usage = tmp_path / 'usage'; usage.mkdir()
    result = review_p0_report(*_stage_fixture(usage, use=False))
    assert result['status'] == 'BLOCKED'
    assert result['productCounts']['PASS'] == 1


def test_stage_review_rejects_stale_or_tampered_binding(tmp_path):
    args = _stage_fixture(tmp_path)
    report, root, expected, frozen = args
    data = json.loads(expected.read_text()); data['codeCommit'] = 'other'
    _write(expected, data)
    assert review_p0_report(*args)['status'] == 'ERROR'


@pytest.mark.parametrize("policy", [_ABSENT, "p0-local-f/v2"])
def test_required_coverage_gap_blocks_even_when_all_observations_pass(tmp_path, policy):
    report, root, expected, frozen = _stage_fixture(tmp_path, policy=policy, use=policy is _ABSENT)
    cases = json.loads(frozen.read_text())
    cases['requiredCoverageGaps'] = [{'id': 'not-yet-covered', 'requirement': 'required missing variant', 'resolution': 'add actual probe'}]
    case_hash, _ = _write(frozen, cases)
    binding = json.loads(expected.read_text()); binding['caseSetSha256'] = case_hash
    binding_hash, _ = _write(expected, binding)
    data = json.loads(report.read_text()); data['binding'] = binding
    for entry in data['files']:
        if entry['path'] in ('execution-freeze.json', 'execution-steps.json'):
            path = root / entry['path']; value = json.loads(path.read_text()); value['expectedBindingSha256'] = binding_hash
            entry['sha256'], entry['bytes'] = _write(path, value)
    _write(report, data)
    result = review_p0_report(report, root, expected, frozen)
    assert result['status'] == 'BLOCKED'
    assert result['productCounts']['PASS'] == 1
    assert any('not-yet-covered' in blocker for blocker in result['blockers'])


@pytest.mark.parametrize("fact,include,status", [(True, True, 'PASS'), (False, True, 'FAIL'), (True, False, 'UNJUDGEABLE')])
def test_local_f_v2_without_manual_use_declaration(tmp_path, fact, include, status):
    args = _stage_fixture(tmp_path, policy='p0-local-f/v2', use=False, fact=fact, include=include)
    result = review_p0_report(*args)
    assert result['status'] == status
    assert result['assessmentPolicy'] == 'p0-local-f/v2'
    assert result['sourceUseSha256'] is None
    assert 'no license authorization' in result['scope']
    assert not (args[1] / 'source-use.json').exists()


@pytest.mark.parametrize("policy,purpose", [('p0-local-f/v3', 'development'), (None, 'development'), ('', 'development'), ('p0-local-f/v2', 'regression')])
def test_invalid_assessment_policy_never_passes(tmp_path, policy, purpose):
    result = review_p0_report(*_stage_fixture(tmp_path, policy=policy, purpose=purpose))
    assert result['status'] == 'ERROR'
    assert any('assessmentPolicy' in p for p in result['problems'])


@pytest.mark.parametrize("mutation", ['report-only', 'report-removed', 'report-changed', 'expected-changed'])
def test_policy_binding_mismatch_never_passes(tmp_path, mutation):
    args = _stage_fixture(tmp_path, policy=_ABSENT if mutation == 'report-only' else 'p0-local-f/v2')
    path = args[2] if mutation == 'expected-changed' else args[0]
    data = json.loads(path.read_text())
    binding = data if mutation == 'expected-changed' else data['binding']
    if mutation == 'report-removed':
        del binding['assessmentPolicy']
    else:
        binding['assessmentPolicy'] = 'p0-local-f/v2' if mutation == 'report-only' else 'tampered'
    _write(path, data)
    result = review_p0_report(*args)
    assert result['status'] == 'ERROR'
    assert any('assessmentPolicy' in p for p in result['problems'])


def test_v2_preserves_product_policy_blocker(tmp_path):
    args = _stage_fixture(tmp_path, policy='p0-local-f/v2', use=False)
    data = json.loads(args[0].read_text())
    data['blockers'] = ['product-policy-denies-purpose']
    _write(args[0], data)
    result = review_p0_report(*args)
    assert result['status'] == 'BLOCKED'
    assert result['blockers'] == ['product-policy-denies-purpose']


def test_legacy_incomplete_use_declaration_still_blocks(tmp_path):
    args = _stage_fixture(tmp_path)
    _write(args[1] / 'source-use.json', {'confirmedForPurpose': True})
    result = review_p0_report(*args)
    assert result['status'] == 'BLOCKED'
    assert 'source-use-record-incomplete-or-mismatched' in result['blockers']


def test_new_policy_requires_stage_freeze_contract(tmp_path):
    args = _fixture(tmp_path)
    binding = {'codeCommit': 'abc', 'purpose': 'development', 'assessmentPolicy': 'p0-local-f/v2'}
    _write(args[2], binding)
    data = json.loads(args[0].read_text()); data['binding'] = binding
    _write(args[0], data)
    assert review_p0_report(*args)['status'] == 'ERROR'


def test_v2_tampered_evidence_is_error_without_reintroducing_manual_use_gate(tmp_path):
    args = _stage_fixture(tmp_path, policy='p0-local-f/v2', use=False)
    _write(args[1] / 'facts.json', {'ok': False})
    result = review_p0_report(*args)
    assert result['status'] == 'ERROR'
    assert not any('source-use' in blocker for blocker in result['blockers'])


@pytest.mark.parametrize("binding", [None, [], "invalid"])
def test_missing_or_malformed_report_binding_is_error(tmp_path, binding):
    args = _stage_fixture(tmp_path, policy='p0-local-f/v2', use=False)
    data = json.loads(args[0].read_text()); data['binding'] = binding
    _write(args[0], data)
    assert review_p0_report(*args)['status'] == 'ERROR'
