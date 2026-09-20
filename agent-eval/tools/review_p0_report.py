"""Read-only structural review for a P0 product-F evidence report.

The product runner writes observations; this command is a separate, deterministic
review step.  It does not execute the product, mutate the instance, publish
anything, repair evidence, or infer business/OCR correctness.  The expected
binding and frozen checks are supplied independently by the quality side.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SHA256_RE = __import__("re").compile(r"^[0-9a-f]{64}$")
REVIEW_SCHEMA = "p0-review/v1"
REPORT_SCHEMA = "p0-f-evidence/v1"


class ReviewError(Exception):
    """A malformed review input or an unsafe evidence path."""


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReviewError(f"cannot read JSON: {path}") from exc


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise ReviewError(f"cannot read evidence: {path}") from exc
    return digest.hexdigest()


def _is_reparse(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError as exc:
        raise ReviewError(f"cannot inspect path: {path}") from exc
    if stat.S_ISLNK(info.st_mode):
        return True
    # FILE_ATTRIBUTE_REPARSE_POINT.  Python exposes this on Windows; keeping
    # the numeric check makes the guard harmless on other platforms.
    return bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _safe_child(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ReviewError(f"evidence path must be relative: {relative!r}")
    # Do not rely on Path.relative_to for lexical traversal: on Windows a
    # candidate containing ``..`` can still be represented as a relative path
    # until it is resolved.  Evidence paths are manifest values, so reject the
    # segment before touching the filesystem.
    if any(part in (".", "..") for part in Path(relative).parts):
        raise ReviewError(f"evidence path contains traversal: {relative!r}")
    candidate = root / Path(relative)
    try:
        relative_parts = candidate.relative_to(root).parts
    except ValueError as exc:
        raise ReviewError(f"evidence path escapes root: {relative!r}") from exc
    current = root
    for part in relative_parts:
        current = current / part
        if _is_reparse(current):
            raise ReviewError(f"evidence path contains a link/reparse point: {relative!r}")
    return candidate


def _pointer(value: Any, pointer: str) -> Any:
    if pointer in ("", "/"):
        return value
    if not pointer.startswith("/"):
        raise ReviewError(f"invalid JSON pointer: {pointer!r}")
    current = value
    for raw in pointer[1:].split("/"):
        key = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(current, list):
            try:
                current = current[int(key)]
            except (ValueError, IndexError) as exc:
                raise ReviewError(f"JSON pointer does not exist: {pointer!r}") from exc
        elif isinstance(current, dict) and key in current:
            current = current[key]
        else:
            raise ReviewError(f"JSON pointer does not exist: {pointer!r}")
    return current


def _same_json(left: Any, right: Any) -> bool:
    return left == right


def _validate_expected_binding(report: dict[str, Any], expected: Any) -> list[str]:
    if not isinstance(expected, dict):
        return ["expected binding must be an object"]
    binding = report.get("binding")
    if not isinstance(binding, dict):
        return ["report.binding is missing"]
    problems: list[str] = []
    for key, value in expected.items():
        if key not in binding:
            problems.append(f"binding field missing: {key}")
        elif not _same_json(binding[key], value):
            problems.append(f"binding mismatch: {key}")
    return problems


def _load_evidence(root: Path, report: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    entries = report.get("files")
    if not isinstance(entries, list):
        return {}, ["report.files must be an array"]
    loaded: dict[str, dict[str, Any]] = {}
    problems: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            problems.append("report.files contains a non-object")
            continue
        path_value = entry.get("path")
        try:
            path = _safe_child(root, path_value)
        except ReviewError as exc:
            problems.append(str(exc))
            continue
        if path_value in loaded:
            problems.append(f"duplicate evidence path: {path_value}")
            continue
        if not SHA256_RE.fullmatch(str(entry.get("sha256", ""))):
            problems.append(f"invalid evidence digest: {path_value}")
            continue
        if not isinstance(entry.get("bytes"), int) or entry["bytes"] < 0:
            problems.append(f"invalid evidence byte count: {path_value}")
            continue
        try:
            actual_bytes = path.stat().st_size
            actual_sha = _sha256(path)
        except ReviewError as exc:
            problems.append(str(exc))
            continue
        if actual_bytes != entry["bytes"]:
            problems.append(f"evidence byte mismatch: {path_value}")
        if actual_sha != entry["sha256"]:
            problems.append(f"evidence digest mismatch: {path_value}")
        value: Any = None
        if path.suffix.lower() == ".json":
            try:
                value = _json(path)
            except ReviewError as exc:
                problems.append(str(exc))
        loaded[path_value] = {"entry": entry, "path": path, "value": value}
    return loaded, problems


def _check_rules(report: dict[str, Any], evidence: dict[str, dict[str, Any]], frozen: Any) -> tuple[list[dict[str, Any]], list[str]]:
    if not isinstance(frozen, dict) or not isinstance(frozen.get("checks"), list):
        return [], ["frozen checks must be an object containing checks[]"]
    report_checks = report.get("checks")
    if not isinstance(report_checks, list):
        return [], ["report.checks must be an array"]
    report_by_key = {(item.get("checkId"), item.get("caseVariantId")): item for item in report_checks if isinstance(item, dict)}
    frozen_by_key = {(item.get("checkId"), item.get("caseVariantId")): item for item in frozen["checks"] if isinstance(item, dict)}
    results: list[dict[str, Any]] = []
    problems: list[str] = []
    if set(report_by_key) != set(frozen_by_key):
        missing = sorted(set(frozen_by_key) - set(report_by_key))
        extra = sorted(set(report_by_key) - set(frozen_by_key))
        if missing:
            problems.append(f"report is missing frozen checks: {missing}")
        if extra:
            problems.append(f"report contains checks outside frozen set: {extra}")
    for key, rule in frozen_by_key.items():
        observation = report_by_key.get(key)
        check_label = f"{key[0]}/{key[1]}"
        issues: list[str] = []
        if observation is None:
            issues.append("missing observation")
        else:
            if observation.get("required") != rule.get("required"):
                issues.append("required flag differs from frozen rule")
            if observation.get("applicable") != rule.get("applicable"):
                issues.append("applicable flag differs from frozen rule")
            if rule.get("applicable", True) and observation.get("status") != rule.get("requiredStatus", "PASS"):
                issues.append(f"status is {observation.get('status')!r}, expected {rule.get('requiredStatus', 'PASS')!r}")
            evidence_paths = observation.get("evidencePaths", [])
            if not isinstance(evidence_paths, list):
                issues.append("evidencePaths is not an array")
                evidence_paths = []
            for path in rule.get("evidencePaths", []):
                if path not in evidence_paths:
                    issues.append(f"required evidence is not cited: {path}")
            for assertion in rule.get("assertions", []):
                if not isinstance(assertion, dict):
                    issues.append("invalid assertion in frozen rule")
                    continue
                path = assertion.get("path")
                if path not in evidence:
                    issues.append(f"assertion evidence missing: {path}")
                    continue
                try:
                    actual = _pointer(evidence[path]["value"], assertion.get("pointer", ""))
                except ReviewError as exc:
                    issues.append(str(exc))
                    continue
                if "equals" in assertion and not _same_json(actual, assertion["equals"]):
                    issues.append(f"assertion failed {path}{assertion.get('pointer', '')}: {actual!r} != {assertion['equals']!r}")
                if "minimum" in assertion and (not isinstance(actual, (int, float)) or actual < assertion["minimum"]):
                    issues.append(f"assertion failed {path}{assertion.get('pointer', '')}: {actual!r} < {assertion['minimum']!r}")
        status = "PASS" if not issues else "UNJUDGEABLE"
        results.append({"checkId": key[0], "caseVariantId": key[1], "status": status, "issues": issues})
        if issues:
            problems.extend(f"{check_label}: {issue}" for issue in issues)
    return results, problems


def review_p0_report(report_path: Path, evidence_root: Path, expected_binding_path: Path, frozen_checks_path: Path) -> dict[str, Any]:
    report = _json(report_path)
    if not isinstance(report, dict) or report.get("schemaVersion") != REPORT_SCHEMA:
        raise ReviewError("report schema is not p0-f-evidence/v1")
    if report.get("scope") != "product" or report.get("phase") != "P0" or report.get("evidenceKind") != "F":
        raise ReviewError("report is not a P0 product-F report")
    expected = _json(expected_binding_path)
    frozen = _json(frozen_checks_path)
    binding_problems = _validate_expected_binding(report, expected)
    evidence, evidence_problems = _load_evidence(evidence_root, report)
    check_results, check_problems = _check_rules(report, evidence, frozen)
    problems = [*binding_problems, *evidence_problems, *check_problems]
    if evidence_problems or binding_problems:
        status = "ERROR"
    elif problems:
        status = "UNJUDGEABLE"
    else:
        status = "PASS"
    return {
        "schemaVersion": REVIEW_SCHEMA,
        "reviewer": "p0-structural-reviewer/v1",
        "reviewedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "reportPath": report_path.as_posix(),
        "evidenceRoot": evidence_root.as_posix(),
        "reportSha256": _sha256(report_path),
        "expectedBindingPath": expected_binding_path.as_posix(),
        "frozenChecksPath": frozen_checks_path.as_posix(),
        "status": status,
        "bindingMatch": not binding_problems,
        "evidenceFilesChecked": len(evidence),
        "checks": check_results,
        "problems": problems,
        "scope": "deterministic report/evidence consistency only; no OCR, business semantic or license authorization conclusion",
    }


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--evidence-root", required=True, type=Path)
    parser.add_argument("--expected-binding", required=True, type=Path)
    parser.add_argument("--frozen-checks", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv or sys.argv[1:])
    try:
        root = args.evidence_root.resolve()
        for path in (args.report, args.expected_binding, args.frozen_checks):
            if _is_reparse(path.resolve()):
                raise ReviewError(f"review input cannot be a link/reparse point: {path}")
        result = review_p0_report(args.report.resolve(), root, args.expected_binding.resolve(), args.frozen_checks.resolve())
    except ReviewError as exc:
        result = {"schemaVersion": REVIEW_SCHEMA, "status": "ERROR", "problems": [str(exc)]}
        if args.output:
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
