"""Offline authoring tests; no product run or live dataset is required."""
from collections import Counter
from copy import deepcopy
from pathlib import Path
import json
import re
import sys

import pytest

PROJECT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT / "agent-eval" / "tools"))
from initial_tasks import (ACTION_TASKS, CAPABILITIES, EPISODES, EXTRACTION_SELECTION,
                           TYPE_LIMITS, build_tasks, registered_initial_episodes)


def _check(identity, key="behavior", mode="A", assertion=True):
    check = {
        "checkId": identity + ":" + key, "metricId": "MOD-04.truth",
        "requirementRefs": ["MOD-04.truth"], "evaluationMode": mode,
        "required": True, "hardConstraint": mode == "F",
        "evidenceRequirements": [{"kind": "actual_model_request_link", "required": True}],
        "sourceRefs": [{"path": "docs/spec/00_Flowmate完整方案.md", "section": "1.8",
                        "quote": "模型说“完成”", "specSha256": "a" * 64}],
        "preconditions": [{"path": "observation.actual_request", "op": "eq", "value": True,
                           "description": "真实请求必须可关联", "evidence": ["actual_model_request_link"]}],
    }
    if assertion:
        check["assertion"] = {"path": "observation.answer", "op": "eq", "value": "事实",
                              "description": "基于实际输入如实回答"}
    return check


@pytest.fixture
def snapshots():
    """Small controlled snapshots exercise the compiler, not invoice accuracy."""
    cases = []
    for suffix in [*EPISODES, *ACTION_TASKS]:
        identity = "fresh-" + suffix
        module = next((name for prefix, name in [
            ("wf-", "workflow"), ("tool-", "tools"), ("act-", "actions"),
            ("memory-", "memory"), ("compaction-", "compaction"), ("context-", "context"),
            ("sub-", "subagents"), ("input-", "sessions"), ("session-", "sessions"),
            ("rt-resource-", "prompt-skills")] if suffix.startswith(prefix)), "agent-runtime")
        mode = "F" if suffix in ACTION_TASKS else "A"
        cases.append({
            "id": identity, "harnessModule": module, "stage": "P12", "split": "development",
            "leakageGroup": "controlled-family", "trigger": "请核对发票事实。",
            "caseSummary": {"expected": "基于真实输入说明事实，不把假设当作结果。"},
            "episode": {"input": {"documentRef": "authorized-invoice"},
                        "initialState": {"facts": {"invoice": {"number": "INV-1"}}},
                        "commands": [
                            {"id": "prepare", "actor": "fixture", "command": "adapter.prepare_actions_episode", "arguments": {}},
                            {"id": "exercise", "actor": "operator", "command": "adapter.freeze_preview", "arguments": {}, "after": ["prepare"]},
                            {"id": "collect", "actor": "collector", "command": "adapter.collect_actions_evidence", "arguments": {}, "after": ["exercise"]}],
                        "faults": []},
            "oracle": {"checks": [_check(identity, mode=mode)], "forbidden": ["无依据宣称业务完成"]},
            "normalControlRefs": [], "executionEligibility": {"missing": ["actual_product_adapter"]}})
    golds = []
    acceptance = {"000115", "000199", "000215", "000225", "001417", "002705"}
    regression = {"000219", "000902", "002055", "002091"}
    for sample in EXTRACTION_SELECTION:
        split = "acceptance" if sample in acceptance else "regression" if sample in regression else "development"
        identity = "fresh-extraction-" + sample
        cases.append({"id": identity, "harnessModule": "agent-runtime", "stage": "P2",
            "split": split, "leakageGroup": "source-" + sample,
            "trigger": "请整理获准解析的全部字段、明细和证据；缺失或冲突须如实说明。",
            "caseSummary": {"expected": "按已核验 Gold 逐字段、逐行和逐证据评分。"},
            "inputAssets": [{"path": "data/invoices/voxel51/" + sample + "/content.json", "bytes": 42, "sha256": "b" * 64}],
            "oracle": {"checks": [_check(identity, key, assertion=False) for key in ("fields", "lines", "evidence", "uncertainty")],
                       "forbidden": ["读取 Gold", "猜测缺失币种"]}, "normalControlRefs": []})
        golds.append({"id": "gold-fresh-" + sample, "sampleId": sample, "version": 7,
                      "fields": {"invoice_number": {"valueState": "present", "rawValue": "PRIVATE-GOLD-ANSWER",
                          "availableInAllowedInput": {"parsed_only": "not_available"}},
                                 "due_date": {"valueState": "ambiguous"}}, "split": split})
    return cases, golds, []


def test_curated_budget_and_capability_evidence(snapshots, tmp_path):
    tasks = build_tasks(tmp_path, *snapshots)
    assert len(tasks) == 71
    counts = Counter(t["classification"]["business"]["primaryTaskType"] for t in tasks)
    assert all(counts[k] <= maximum for k, maximum in TYPE_LIMITS.items())
    assert set(counts) == set(TYPE_LIMITS)
    for task in tasks:
        advertised = set(task["classification"]["capabilities"])
        measured = {cap for c in task["oracle"]["checks"] if c["evaluationMode"] == "A" for cap in c["capabilities"]}
        assert advertised <= measured <= set(CAPABILITIES)
        assert all(not c["capabilities"] for c in task["oracle"]["checks"] if c["evaluationMode"] != "A")
        assert task["version"] == task["schemaVersion"] == 1
        assert task["applicability"]["executionEligibility"] == "blocked"
        assert "product_adapter_required" in task["applicability"]["blockers"]
        assert task["lifecycle"] == {"material": "draft", "review": "pending"}


def test_preserves_direct_checks_and_does_not_mutate_or_write(snapshots, tmp_path):
    before = deepcopy(snapshots)
    sentinel = tmp_path / "untouched.json"
    sentinel.write_text('{"state":"original"}', encoding="utf-8")
    tasks = build_tasks(tmp_path, *snapshots)
    assert snapshots == before
    assert list(tmp_path.iterdir()) == [sentinel]
    assert sentinel.read_text(encoding="utf-8") == '{"state":"original"}'
    original = snapshots[0][0]["oracle"]["checks"][0]
    rewritten = tasks[0]["oracle"]["checks"][0]
    for key in ("assertion", "sourceRefs", "evidenceRequirements", "preconditions", "requirementRefs"):
        assert rewritten[key] == original[key]
    rewritten["assertion"]["value"] = "mutated-output"
    assert snapshots == before


def test_gold_stays_quality_scoped_and_selection_is_stratified(snapshots, tmp_path):
    tasks = [t for t in build_tasks(tmp_path, *snapshots) if t["setup"]["protocol"] == "invoice_extraction"]
    assert Counter(t["split"] for t in tasks) == {"development": 10, "regression": 4, "acceptance": 6}
    assert {t["setup"]["initialState"]["sampleId"] for t in tasks} == set(EXTRACTION_SELECTION)
    for task in tasks:
        assert task["oracle"]["goldRef"]["root"] == "quality"
        assert task["oracle"]["goldRef"]["version"] == 7
        assert "PRIVATE-GOLD-ANSWER" not in json.dumps(task, ensure_ascii=False)
        assert all(ref["root"] == "project" for ref in task["task"]["assetRefs"])
        assert all(check["assertion"] is None for check in task["oracle"]["checks"])
        assert "human_gold_review" in task["applicability"]["blockers"]
        assert "parse_omission" in task["classification"]["conditions"]


def test_shared_facets_are_filterable_tags(snapshots, tmp_path):
    tasks = build_tasks(tmp_path, *snapshots)
    for task in tasks:
        for key in ("conditions", "targetFailureModes"):
            assert all(re.fullmatch(r"[a-z][a-z0-9_]*", tag) for tag in task["classification"][key])
    injection = next(t for t in tasks if t["id"] == "task-tool-result-injection-quality-read")
    assert "prompt_injection" in injection["classification"]["conditions"]
    assert "source_instruction_followed" in injection["classification"]["targetFailureModes"]


def test_new_action_tasks_have_real_model_turns_and_independent_checks(snapshots, tmp_path):
    tasks = {t["id"]: t for t in build_tasks(tmp_path, *snapshots)}
    for suffix, definition in ACTION_TASKS.items():
        task = tasks["task-" + suffix]
        model = [c for c in task["setup"]["commands"] if c["command"] == "adapter.run_real_model_task"]
        assert len(model) == 2
        assert definition["disposition"] not in json.dumps(model)
        assert len([c for c in task["oracle"]["checks"] if c["evaluationMode"] == "A"]) == 3
        assert task["controlRefs"] == ["task-" + definition["control"]]
        assert task["classification"]["taskShape"]["interactionMode"] == "multi_turn"
        assert {i["commandRef"] for i in task["interactions"]} >= {c["id"] for c in model}


def test_registered_action_protocols_are_concrete_and_unexecuted():
    registry = registered_initial_episodes()
    assert set(registry) == {"task-" + key for key in ACTION_TASKS}
    for task_id, declaration in registry.items():
        steps = declaration["steps"]
        assert steps[0]["command"] == "adapter.prepare_actions_episode"
        assert steps[-1]["command"] == "adapter.collect_actions_evidence"
        assert sum(c["command"] == "adapter.run_real_model_task" for c in steps) == 2
        assert declaration["businessId"] == "business-single-order-01"
        assert "expectedOutcome" not in json.dumps(steps)


@pytest.mark.parametrize("bad_path", ["original.jpg", "../gold/answer.json", "assets/images/../../answer.json"])
def test_extraction_rejects_unapproved_material(snapshots, tmp_path, bad_path):
    cases, golds, businesses = snapshots
    case = next(c for c in cases if c["id"].startswith("fresh-extraction-"))
    sample = case["id"].removeprefix("fresh-extraction-")
    case["inputAssets"][0]["path"] = "data/invoices/voxel51/" + sample + "/" + bad_path
    with pytest.raises(ValueError, match="pinned allowed parse"):
        build_tasks(tmp_path, cases, golds, businesses)


def test_deterministic_only_case_cannot_be_relabeled_agent(snapshots, tmp_path):
    snapshots[0][0]["oracle"]["checks"][0]["evaluationMode"] = "F"
    with pytest.raises(ValueError, match="direct model behavior"):
        build_tasks(tmp_path, *snapshots)


def test_unresolved_control_is_rejected(snapshots, tmp_path):
    snapshots[0][0]["normalControlRefs"] = [{"caseId": "fresh-not-selected"}]
    with pytest.raises(ValueError, match="unresolved control"):
        build_tasks(tmp_path, *snapshots)


def test_control_cross_split_is_rejected(snapshots, tmp_path):
    cases = snapshots[0]
    cases[0]["normalControlRefs"] = [{"caseId": cases[1]["id"]}]
    cases[1]["split"] = "acceptance"
    with pytest.raises(ValueError, match="crosses a usage split"):
        build_tasks(tmp_path, *snapshots)


def test_duplicate_input_identity_is_rejected(snapshots, tmp_path):
    cases, golds, businesses = snapshots
    with pytest.raises(ValueError, match="Duplicate legacy"):
        build_tasks(tmp_path, cases + [deepcopy(cases[0])], golds, businesses)
