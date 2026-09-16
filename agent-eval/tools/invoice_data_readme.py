"""Refresh the full data manual without discarding valid parameter explanations."""
from __future__ import annotations

from collections import defaultdict
import json
import re


APPENDIX_A = "## 附录 A："
APPENDIX_B = "## 附录 B："
HISTORY = "### 9.4 "


def _rows(section):
    rows = {}
    for line in section.splitlines():
        match = re.match(r"^\| `([^`]+)` \| (.*) \|$", line)
        if match:
            rows[match[1]] = match[2].split(" | ")
    return rows


def _type(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    return "array" if isinstance(value, list) else "object"


def _conditions(value, prefix=""):
    if isinstance(value, dict) and value:
        for key, child in value.items():
            yield from _conditions(child, f"{prefix}.{key}" if prefix else key)
    elif isinstance(value, list) and any(isinstance(child, dict) for child in value):
        for child in value:
            yield from _conditions(child, prefix + "[]")
    elif prefix:
        yield prefix, _type(value)


def _cell(value):
    return str(value).replace("|", "&#124;").replace("\n", " ").replace("\r", " ")


def _appendices(text, cases):
    before, a = text.split(APPENDIX_A, 1)
    a, b = a.split(APPENDIX_B, 1)
    old_a, old_b = _rows(a), _rows(b)
    types, categories, assertions = defaultdict(set), defaultdict(set), defaultdict(lambda: defaultdict(set))
    for case in cases:
        setup = case.get("initialEnvironment", {}).get("scenarioSetup", {})
        for key, kind in _conditions(setup.get("conditions", {})):
            types[key].add(kind)
            categories[key].add(case["category"])
        for assertion in case.get("oracle", {}).get("assertions", []):
            assertions[assertion["path"]][assertion["op"]].add(json.dumps(assertion.get("value"), ensure_ascii=False, sort_keys=True))

    # Existing descriptions are authoritative prose; unknown additions must be documented.
    additions = {"employee": "当前用例声明的员工配置初态；null 表示未提供配置，不代表已创建通用员工"}
    missing = set(types) - set(old_a) - set(additions)
    missing |= set(assertions) - set(old_b)
    if missing:
        raise ValueError("Missing parameter explanations: " + ", ".join(sorted(missing)))
    a_head = a.split("| 参数（conditions 下）", 1)[0]
    b_head = b.split("| 观测路径", 1)[0]
    a_lines = ["| 参数（conditions 下） | 实际类型 | 含义 | 出现类别 |", "|---|---|---|---|"]
    for key in sorted(types):
        description = old_a[key][1] if key in old_a else additions[key]
        if key == "requestedAction":
            description = "请求执行的具体 B2B 提交动作；仍需有效提交确认与当前载荷绑定"
        a_lines.append(f"| `{key}` | {', '.join(sorted(types[key]))} | {_cell(description)} | {', '.join(sorted(categories[key]))} |")
    b_lines = ["| 观测路径 | 含义 | 当前比较要求 |", "|---|---|---|"]
    for key in sorted(assertions):
        groups = []
        for op, values in sorted(assertions[key].items()):
            detail = ", ".join(sorted(values))
            if len(values) > 8 or len(detail) > 160:
                detail = f"具体值或序列按当前 Case（{len(values)} 种配置）"
            groups.append(op + "；" + detail)
        b_lines.append(f"| `{key}` | {_cell(old_b[key][0])} | {_cell('；'.join(groups))} |")
    # Preserve any following section rather than assuming B remains the final section.
    trailing = re.search(r"\n## (?!附录 B：)", b)
    suffix = b[trailing.start():] if trailing else ""
    return before + APPENDIX_A + a_head + "\n".join(a_lines) + "\n\n" + APPENDIX_B + b_head + "\n".join(b_lines) + "\n" + suffix


def refresh_readme(text, cases, report):
    """Return the complete manual updated for current cases; never write any file.

    The migration caller supplies the archived original manual, current Case
    objects and the new preparation report. Historical attestation totals are
    preserved independently of the active dataset counts.
    """
    newline = "\r\n" if "\r\n" in text else "\n"
    text = text.replace("\r\n", "\n")
    cases = list(cases)
    if APPENDIX_A not in text or APPENDIX_B not in text or HISTORY not in text:
        raise ValueError("A full manual with both appendices and the attestation section is required")
    if report["caseDrafts"] != len(cases):
        raise ValueError("Case count disagrees with preparation report")
    text = _appendices(text, cases)
    # Protect the complete human attestation section from current-count rewrites.
    history_start = text.index(HISTORY)
    history_end = text.index("\n## ", history_start)
    history = text[history_start:history_end]
    text = text[:history_start] + "@@PRESERVED_HUMAN_ATTESTATION@@" + text[history_end:]
    count = len(cases)
    materialization = report.get("materialization", {})
    fixture_count = materialization.get("fixtureCount", 0)
    text = re.sub(r"^\| 评测用例 \|.*$", f"| 评测用例 | {count:,} | 七类固定实例，{report['scenarioFamilies']} 个场景族、{report['distinctSemanticScenarioKeys']:,} 个语义键 |", text, flags=re.M)
    text = re.sub(r"^\| 额外重复实例 \|.*$", f"| 额外重复实例 | {report['replicaInstancesBeyondFirst']:,} | 同语义键首例以外的分配，不增加独立业务覆盖 |", text, flags=re.M)
    text = re.sub(r"^\| 离线夹具 \|.*$", f"| 离线夹具 | {fixture_count:,} | 能构造输入，其余 {count-fixture_count:,} 个仍有物化依赖 |", text, flags=re.M)
    descriptions = {
        "matching": "供应商、订单、收货、合同价格、数量、订单余额与重复检查例；匹配按需",
        "approval": "修订、澄清、具体 B2B 提交确认、撤销、过期和接管例",
        "submission": "B2B 提交、权威回读、UNKNOWN 和恢复例",
    }
    for category, description in descriptions.items():
        text = re.sub(rf"^(\| `cases/{category}/` \| )[^|]+(\|.*)$", lambda m: m[1] + f"{report['caseCounts'][category]:,} 个{description} " + m[2], text, flags=re.M)
    text = text.replace("1200/600/6000", f"1200/600/{count}")
    text = re.sub(r"覆盖必须由检查项重算一致，当前 \d+ 条部分准备、\d+ 条未覆盖，", "覆盖必须由检查项重算一致，当前部分准备和未覆盖数量以 coverage.json 与 preparation-report.json 为准，", text)
    replacements = {
        "待人工核验，不能直接当正确答案": "保留材料审核声明，逐字段答案及证据待发布，不能直接当正确答案",
        "targetSystems.b2b/erp.kind/records[]": "targetSystems.b2b.kind/records[]",
        "B2B/ERP 独立 local_simulator 类型和初始台账": "B2B 的 local_simulator 类型和初始台账；ERP 仅可作为获准只读业务资料",
        "| `validApprovalRequiredForSubmission` | 提交必须有效审批，true |": "| `validSubmissionConfirmationRequired` | 具体 B2B 提交必须有对当前载荷、附件及目标的有效人工确认，true |\n| `executionTargets[]` | 当前仅 b2b，不能扩展为其他写入目标 |",
        "scenarioSetup.policy/currency/approvalLimit/invoiceValuesOrigin": "scenarioSetup.policy/currency/confirmationKind/invoiceValuesOrigin",
        "模拟政策、币种、额度、数字来自模拟而非原票的来源说明": "模拟政策、币种、submission_confirmation 提交确认类别、数字来自模拟而非原票的来源说明",
        "policy.version/currency/approvalLimit/amountTolerance/poRequired": "policy.version/currency/confirmationKind/amountTolerance/poRequired",
        "政策身份、币种、额度、容差、PO 要求": "政策身份、币种、提交确认类别、容差、当前 Case 的 PO 要求",
        "目标、查询、ERP、附件故障配置": "B2B 目标、查询、附件故障配置",
        "`targetBehavior` / `erpBehavior`": "`targetBehavior`",
        "`queryBehavior` / `erpQueryBehavior`": "`queryBehavior`",
        "首次整理用的项目内部暂存目录，当前已整理根拒绝重分配": "仅作首次机器草案合并，不能覆盖已有人工审核历史的当前根",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    removed = ("`b2bSuccessDoesNotImplyErpSuccess`", "`approverAmountLimit`", "`erpAuthorization.action/valid`", "`faults.verificationService.result/source`")
    text = "\n".join(line for line in text.split("\n") if not (line.startswith("|") and any(key in line for key in removed)))
    text = text.replace("审批", "提交确认")
    text = text.replace("额度或多级财务提交确认", "额度或多级财务审批")
    scope_note = "本轮保留外部解析导入、原件证据和 A2 收货、合同价格、数量、订单余额检查；匹配按需。人工可修订、澄清、确认具体 B2B 提交并接管，内容或授权变化使旧确认失效。当前不执行产品 OCR/Parser、外部发票验真、ERP 回写、自动拆合票、额度或多级财务审批，也不要求强制两人分离、通用员工创建/复杂配置 UI 或第二任务证明。P0–P13、Pi 原生机制与平台基础验证保留。"
    if scope_note not in text:
        text = text.replace("### 1.2 ", scope_note + "\n\n### 1.2 ", 1)
    note = "范围迁移保留旧 7,801 项资产的声明及其绑定内容（旧 Case 数为 6,000）；未改 Gold 和来源继续保留。旧记录位于 `manifests/reviews/user-confirmation-20260915T145419376406Z.json`，所绑定旧内容见 `manifests/history/*.zip`。`manifests/scope-sync.json` 记录本次退役和修订；修改后的业务资料、Case 和政策待重新复核，不继承旧确认。该历史声明不增加结构化 Gold 或真实运行数。"
    if note not in history:
        history = history.replace("\n\n", "\n\n" + note + "\n\n", 1)
    history = history.replace("前者确认用户已审核且接受当前内容", "前者确认用户已审核且接受登记时内容")
    history = history.replace("当前批量记录由", "原批量记录由")
    text = text.replace("@@PRESERVED_HUMAN_ATTESTATION@@", history)
    return text.replace("\n", newline)
