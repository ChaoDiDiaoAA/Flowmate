import unittest

from invoice_data_readme import refresh_readme


MANUAL = """# 完整手册

### 1.1 当前规模
| 评测用例 | 6,000 | 旧规模 |
| 离线夹具 | 2,633 | 旧物化 |
### 1.2 目录树
保留原件与字段证据的详细解释。
## 参数字典
| `validApprovalRequiredForSubmission` | 提交必须有效审批，true |
| `approverAmountLimit` | 模拟审批额度 10000.00，不是企业实际政策 |
| `faults.verificationService.result/source` | 模拟验真 |
| `policy.version/currency/approvalLimit/amountTolerance/poRequired` | 政策身份、币种、额度、容差、PO 要求 |
### 9.4 用户批量审核确认记录

用户接受旧 6,000 个 Case；scope.totalAssets=7801。
保留审核者原话和字段证据解释。
## 十、runs
未执行不能宣称通过。
## 附录 A：全部现有场景条件参数

场景初态不是实际执行。
| 参数（conditions 下） | 实际类型 | 含义 | 出现类别 |
|---|---|---|---|
| `trustedRole` | string | 可信审核/审批角色 | approval |
| `erpRequired` | boolean | ERP 必需 | submission |
| `verificationRequired` | boolean | 验真必需 | matching |
## 附录 B：全部现有观测断言路径

观测路径说明保留。
| 观测路径 | 含义 | 当前比较要求 |
|---|---|---|
| `observation.approval.status` | 最终状态，由 Case 决定 | eq；旧值 |
| `observation.erp.newWrites` | ERP 新写 | eq；0 |
## 后续说明
后续扩展必须保留。
"""
CASE = {
    "category": "approval",
    "initialEnvironment": {"scenarioSetup": {"conditions": {"trustedRole": "approver"}}},
    "oracle": {"assertions": [{"path": "observation.approval.status", "op": "eq", "value": "approved"}]},
}
REPORT = {
    "caseDrafts": 1, "scenarioFamilies": 1, "distinctSemanticScenarioKeys": 1,
    "replicaInstancesBeyondFirst": 0,
    "caseCounts": {"matching": 0, "approval": 1, "submission": 0},
    "materialization": {"fixtureCount": 1},
}


class RefreshReadmeTests(unittest.TestCase):
    def test_preserves_manual_and_historical_attestation_without_rewriting_totals(self):
        original = MANUAL.replace("\n", "\r\n")
        updated = refresh_readme(original, [CASE], REPORT)
        for paragraph in (
            "保留原件与字段证据的详细解释。", "用户接受旧 6,000 个 Case；scope.totalAssets=7801。",
            "保留审核者原话和字段证据解释。", "未执行不能宣称通过。", "后续扩展必须保留。",
        ):
            self.assertIn(paragraph, updated)
        self.assertIn("| 评测用例 | 1 |", updated)
        self.assertEqual(updated.count("\n"), updated.count("\r\n"))
        self.assertEqual(updated, refresh_readme(updated, [CASE], REPORT))

    def test_rebuilds_dictionary_from_current_cases_and_updates_policy(self):
        updated = refresh_readme(MANUAL, [CASE], REPORT)
        for retired in ("`erpRequired`", "`verificationRequired`", "`observation.erp.newWrites`", "`approverAmountLimit`", "`faults.verificationService.result/source`", "approvalLimit"):
            self.assertNotIn(retired, updated)
        self.assertIn("`validSubmissionConfirmationRequired`", updated)
        self.assertIn("`executionTargets[]`", updated)
        self.assertIn("| `trustedRole` | string | 可信审核/提交确认角色 | approval |", updated)
        self.assertIn('eq；"approved"', updated)
        self.assertNotIn("eq；旧值", updated)


if __name__ == "__main__":
    unittest.main()
