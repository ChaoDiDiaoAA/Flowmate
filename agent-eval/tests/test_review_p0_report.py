import hashlib
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1] / "tools"
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
