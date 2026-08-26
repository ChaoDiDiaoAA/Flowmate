# G 单人运维、备份、升级与灾难恢复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to execute this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 让唯一开发维护者可以用固定节奏监控系统、处理故障、恢复备份、安全升级，并在本人不可用时让业务退回人工流程。

**Architecture:** 自动健康检查和告警负责发现问题；Runbook 负责固定处置；加密备份和版本化发布负责恢复；人工流程是最终业务兜底。

**Tech Stack:** 结构化日志、Audit、健康检查、备份脚本、恢复脚本、版本化 Dataset、Git 和安装包归档。

**Spec:** [F 阶段](F_正式生产上线与最终交付教程.md)、[测试手册](03_测试验收与排错操作手册.md)

## Global Constraints

- 单人维护不设计依赖持续盯屏的系统；
- 无人响应期间可自动暂停写入，不自动扩大权限；
- 所有恢复和升级先在副本或测试环境演练；
- 外部系统状态优先于本地推测；
- 不删除唯一备份；
- 业务必须保留人工处理路径；
- 故障修复必须增加回归测试。

---

## Task G1：建立运维日历

### 每日自动检查

```text
应用进程健康
新任务积压
FAILED/UNKNOWN_COMMIT 数量
B2B 登录状态
OCR/LLM/ERP 健康
磁盘空间
Audit 写入
备份任务状态
证书和凭证到期天数
```

### 每周人工检查

```text
失败案例分类
人工介入率变化
成本和 P95 耗时
页面 Selector 失败
数据漂移
备份可读取
依赖安全告警
```

### 每月人工演练

```text
恢复一份数据库备份
打开一个历史 Job 和 Audit
验证 Kill Switch
验证机器人账号停用流程
运行 regression 数据集
审查真实数据保留期限
与业务 Owner 复核新增异常
```

## Task G2：告警分级

| 级别 | 示例 | 动作 |
|---|---|---|
| SEV-1 | 重复提交、未审批写入、严重错录、审计丢失 | 立即 Kill Switch，通知业务，保护证据 |
| SEV-2 | 大量任务失败、B2B 不可用、Unknown Commit 堆积 | 停止新写任务，切人工，开始诊断 |
| SEV-3 | 单个可恢复失败、OCR 精度下降、Selector 局部变化 | 转人工，记录案例，计划修复 |
| SEV-4 | UI 小问题、非关键报表错误 | 记录并排入维护窗口 |

没有夜间或假期人工值守时，系统应默认停止新的高风险写入，并明确通知业务改走人工流程。

## Task G3：故障处理固定流程

```text
确认告警
→ 判断是否涉及真实写入
→ 必要时开启 Kill Switch
→ 保存应用版本、Job ID、日志和外部状态
→ 查询 B2B/ERP 权威结果
→ 保护人工业务连续性
→ 复现问题
→ 增加失败测试
→ 最小修复
→ regression
→ 受控恢复
→ 复盘和更新 Runbook
```

禁止动作：

- Unknown Commit 直接重复提交；
- 未确认外部状态就修改数据库为成功或失败；
- 在生产数据库上试验修复脚本；
- 删除日志来“恢复正常”；
- 把含敏感数据的完整日志直接发给 AI。

## Task G4：备份自动化

**Files:**

- Create: `scripts/backup-production.ps1`
- Create: `scripts/verify-backup.ps1`
- Create: `scripts/restore-drill.ps1`
- Test: `scripts/test/backup-scripts.Tests.ps1`

备份至少包含：

- SQLite/PostgreSQL 一致性备份；
- Audit 数据；
- 必要附件引用和对象存储清单；
- 应用版本和配置摘要；
- 数据库 Schema 版本；
- Dataset manifest；
- checksums。

不在备份日志中输出真实密钥。备份加密后再复制到第二位置。

- [ ] 每日自动备份。
- [ ] 每周自动校验 hash 和可读取性。
- [ ] 每月至少一次隔离恢复。
- [ ] 每次恢复记录实际 RTO 和可达到的 RPO。

## Task G5：安全升级流程

任何 Pi SDK、Electron、Node、OCR、Playwright 或数据库依赖升级都按顺序执行：

```text
阅读官方变更说明
→ 创建升级分支
→ 更新一个依赖组
→ lint/typecheck/unit
→ regression dataset
→ Mock E2E
→ 07B2B 测试环境 E2E
→ 备份和回滚演练
→ Shadow
→ 小流量 Canary
→ 正式发布
```

不要在一个版本中同时升级所有基础依赖和修改业务规则，否则失败时无法定位原因。

## Task G6：凭证和证书轮换

Obsidian `04_SystemAccess` 只记录：

```text
credential profile id
系统名称
Owner 角色
到期日期
轮换周期
最后验证日期
停用联系人
```

不记录密钥值。

轮换步骤：

```text
创建或取得新凭证
→ 在测试健康检查验证
→ 更新 Secret Store 引用
→ 验证旧任务不受影响
→ 停用旧凭证
→ 检查日志没有泄露
→ 记录 Audit
```

## Task G7：数据和业务漂移

每月使用新近真实案例检查：

- 新发票版式；
- 新供应商；
- 新票种和税率；
- OCR Provider 行为变化；
- 07B2B 字段和页面变化；
- 新业务规则；
- 新异常类型；
- 人工介入率和 STP 趋势。

新案例先进入下一版 development 数据集，完成标注、业务复核和回归后再更新生产版本。

## Task G8：唯一维护者不可用预案

🏢 与业务 Owner 约定：

```text
谁可以开启 Kill Switch
谁可以停用机器人账号
系统暂停后人工任务从哪里领取
Unknown Commit 由谁查询
业务记录如何人工修正
紧急联系人如何升级
你的计划不可用时间如何提前通知
```

至少准备一页不需要懂代码的《业务紧急停用卡》：

```text
1. 停止新任务
2. 开启 Kill Switch
3. 停用机器人账号（必要时）
4. 切回人工处理
5. 保存 Job ID 和时间
6. 联系系统 Owner
```

## Task G9：季度健康审查

每季度回答：

```text
系统仍然节省时间吗？
哪些任务不应继续自动化？
异常和人工介入是否在上升？
外部系统接口是否即将变化？
数据授权和保存期限是否仍有效？
单人维护成本是否已超过收益？
是否需要第二名维护者或正式服务团队？
```

当处理量、合规要求或支持时间超过单人能力时，正确动作是限制自动化范围或引入组织支持，而不是隐藏风险。

## G 阶段持续合格标准

```text
[ ] 每日健康检查有效
[ ] 告警能到达你和业务联系人
[ ] 每月恢复演练成功
[ ] Kill Switch 可由授权业务人员使用
[ ] 人工业务回退可用
[ ] Regression 定期运行
[ ] 依赖升级经过 Shadow/Canary
[ ] 凭证到期前完成轮换
[ ] 数据漂移进入新版数据集
[ ] 唯一维护者不可用预案已演练
```

G 没有“永久完成”状态。它是正式交付后的持续流水线。

