"""Synthetic quality-facility tests. Never start the product or read its data."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'tools' / 'p0'))
from p0_stage import evaluate_case, aggregate_stage, validate_cases


def case(**overrides):
    return {"id": "P0-F01", "scope": "product", "required": True,
            "oracle": {"assertions": [{"path": "facts.json", "pointer": "/ok", "equals": True}]},
            **overrides}


def test_exact_oracle_and_missing_evidence_are_distinct():
    assert evaluate_case(case(), {"facts.json": {"ok": True}})["status"] == "PASS"
    assert evaluate_case(case(), {"facts.json": {"ok": False}})["status"] == "FAIL"
    assert evaluate_case(case(), {})["status"] == "UNJUDGEABLE"


def test_suite_success_cannot_replace_a_named_case_or_skipped_test():
    c = case(oracle={"tests": [{"file": "tests/product/a.test.ts", "title": "required test"}]})
    doc = {"success": True, "testResults": [{"name": "D:/repo/tests/product/a.test.ts", "assertionResults": []}]}
    assert evaluate_case(c, {"vitest-product.json": doc})["status"] == "NOT_RUN"
    doc["testResults"][0]["assertionResults"] = [{"title": "required test", "status": "pending"}]
    assert evaluate_case(c, {"vitest-product.json": doc})["status"] == "NOT_RUN"
    doc["testResults"][0]["assertionResults"][0]["status"] = "failed"
    assert evaluate_case(c, {"vitest-product.json": doc})["status"] == "FAIL"
    doc['testResults'][0]['assertionResults'][0]['failureMessages'] = ['[P0_FACILITY] Windows junction creation unavailable']
    assert evaluate_case(c, {"vitest-product.json": doc})["status"] == "ERROR"


def test_failure_is_not_hidden_by_missing_evidence():
    c = case(oracle={"assertions": [
        {"path": "facts.json", "pointer": "/ok", "equals": True},
        {"path": "missing.json", "pointer": "/ok", "equals": True}]})
    assert evaluate_case(c, {"facts.json": {"ok": False}})["status"] == "FAIL"


def test_empty_invalid_and_manual_evidence_do_not_pass():
    assert evaluate_case(case(oracle={}), {})["status"] == "ERROR"
    assert evaluate_case(case(oracle={"manual": "needs independent evidence"}), {})["status"] == "NOT_RUN"
    assert evaluate_case(case(), {"facts.json": {}})["status"] == "UNJUDGEABLE"


def test_facility_is_separate_and_blockers_prevent_stage_pass():
    rows = [dict(case(), status="PASS"), dict(case(id="P0-F32", scope="facility"), status="PASS")]
    result = aggregate_stage(rows, [])
    assert result["productCounts"]["PASS"] == 1
    assert result["facilityCounts"]["PASS"] == 1
    assert result["stageStatus"] == "PASS"
    assert aggregate_stage(rows, ["source-use-not-verified"])["stageStatus"] == "BLOCKED"
    rows[0]["status"] = "FAIL"
    assert aggregate_stage(rows, ["source-use-not-verified"])["stageStatus"] == "FAIL"


def test_duplicate_case_and_empty_stage_rejected():
    import pytest
    with pytest.raises(ValueError): validate_cases({"schemaVersion": "p0-stage-cases/v1", "cases": []})
    with pytest.raises(ValueError): validate_cases({"schemaVersion": "p0-stage-cases/v1", "cases": [case(), case()]})
