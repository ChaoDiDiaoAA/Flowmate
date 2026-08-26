# E Canary 小流量真实写入计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 仅对明确白名单中的低风险任务开放少量真实提交，在可立即停止、查询和人工修正的条件下验证真实写入。

**Architecture:** Tool Gateway 同时执行白名单、风险、Approval、幂等、运行模式和 Kill Switch 检查；Canary 比例逐级扩大，每一级必须独立验收。

**Tech Stack:** 生产 B2B Adapter、生产 Credential Adapter、Policy Engine、Approval、Idempotency Store、监控告警。

**Spec:** [D 阶段](D_生产Shadow只读试点教程.md)、[测试手册](03_测试验收与排错操作手册.md)

## Global Constraints

- 使用专用机器人账号，不长期借用员工个人账号；
- Canary 不等于自动全量写入；
- 每次扩量必须人工批准；
- Unknown Commit 禁止直接 retry；
- Kill Switch 必须在 Agent、Tool Gateway 和调度入口均有效；
- 严重错录、重复提交或审计缺失立即停止全部写入；
- 人工能够在业务 SLA 内接管和修正。

---

## 进入条件

```text
[ ] D 阶段完整业务周期通过
[ ] 业务 Owner 书面批准 Canary 范围
[ ] 信息安全批准机器人账号及权限
[ ] 生产 B2B 自动化访问已获许可
[ ] 回滚和人工修正流程已演练
[ ] Kill Switch 已演练
[ ] Unknown Commit 状态查询已在测试环境验证
[ ] 监控告警可通知到你和业务联系人
```

## Task E1：建立 Canary 白名单

**Files:**

- Create: `packages/domain/src/canary-policy.ts`
- Create: `apps/desktop/src/main/canary-config-service.ts`
- Test: `packages/domain/test/canary-policy.test.ts`

第一批白名单建议同时限制：

```text
固定组织
固定供应商
固定票种
低风险金额区间
已存在且唯一匹配的 PO
高 OCR confidence
无历史异常
工作时间内
人工在线
```

- [ ] 🤖 不满足任何一项都转人工，不降级成无保护提交。
- [ ] 🤖 配置变化产生 Audit，并显示生效时间。
- [ ] 👤 保存点：`feat: enforce canary allowlist`。

## Task E2：专用生产凭证

- [ ] 🏢 申请专用机器人账号、最小角色和允许操作组织。
- [ ] 🏢 确认密码轮换、MFA、锁定和停用联系人。
- [ ] 🤖 生产 Credential Adapter 只按 accountProfileId 取密钥。
- [ ] 🤖 账号过期或权限不足自动停止该账号的新任务。
- [ ] 👤 检查 Renderer、日志、Audit、截图均无原始凭证。

## Task E3：幂等与 Unknown Commit

**Files:**

- Create: `packages/domain/src/idempotency.ts`
- Create: `packages/domain/src/unknown-commit-resolver.ts`
- Test: `packages/domain/test/unknown-commit.test.ts`

固定流程：

```text
生成稳定业务幂等键
→ 保存提交意图
→ 执行一次 Submit
→ 明确成功：记录 externalId
→ 明确失败：按错误策略处理
→ 响应未知：UNKNOWN_COMMIT_STATE
→ 调用 getStatus
→ 已提交：转 SUBMITTED
→ 未提交且得到权威确认：重新申请人工决定
```

- [ ] 🤖 进程在 Submit 后崩溃，恢复时先查询状态。
- [ ] 🤖 相同幂等键只允许一个有效提交记录。
- [ ] 👤 保存点：`feat: prevent duplicate production commits`。

## Task E4：Kill Switch

**Files:**

- Create: `packages/domain/src/kill-switch.ts`
- Create: `apps/desktop/src/renderer/components/KillSwitchControl.tsx`
- Test: `apps/desktop/e2e/kill-switch.spec.ts`

Kill Switch 开启后：

- 不启动新写任务；
- 已到提交前的任务暂停；
- 已发送请求的任务继续查询最终状态；
- 只读状态查询仍可运行；
- 操作产生高优先级 Audit 和告警。

- [ ] 👤 在测试环境和生产第一批前各演练一次。
- [ ] 👤 保存点：`feat: add production write kill switch`。

## Task E5：分级放量

每一级使用“符合白名单任务中的最大比例”，而不是全量任务比例：

```text
Level 1：最多 5%，且最多 5 个任务
Level 2：最多 10%，且最多 20 个任务
Level 3：最多 25%
Level 4：最多 50%
```

每一级至少观察业务 Owner 同意的完整窗口，并检查：

- 最终业务记录；
- 重复提交；
- 金额、税额、供应商、PO；
- 人工审批；
- Audit 和截图；
- ERP 后续状态；
- 告警和人工响应时间。

- [ ] 👤 每一级单独填写 `docs/07b2b/evidence/phase-e/level-N.md`。
- [ ] 🏢 业务 Owner 批准后才修改到下一级。

## Task E6：自动停止规则

任一条件触发立即开启 Kill Switch：

```text
严重错录 ≥ 1
重复有效提交 ≥ 1
未审批写入 ≥ 1
Audit 缺失 ≥ 1
无法确认的 Unknown Commit 超过人工响应窗口
账号权限异常
页面发生未识别重大变化
核心监控不可用
备份或恢复验证失败
```

停止后先保护业务事实和外部状态，不让 AI 直接批量重试。

## E 阶段退出门

```text
[ ] 至少完成 5%→10%→25% 的受控级别
[ ] 自动提交成功率 ≥ 95%
[ ] 严重错录 = 0
[ ] 重复提交 = 0
[ ] 未审批写入 = 0
[ ] Audit 完整率 = 100%
[ ] Unknown Commit 全部获得最终结论
[ ] 人工介入和修正满足业务 SLA
[ ] Kill Switch 在生产演练成功
[ ] 业务和安全负责人批准正式上线
```

只有全部通过才进入 F。没有必要为了“达到 100%”而取消高风险任务的人工审批。

