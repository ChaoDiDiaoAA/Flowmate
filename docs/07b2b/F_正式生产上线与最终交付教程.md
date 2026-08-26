# F 正式生产上线与最终交付计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 把通过 Canary 的系统部署为可恢复、可审计、可监控的正式生产版本，并完成真实数据、软件、测试、培训和运维资料交付。

**Architecture:** 生产执行路径全部使用获准的 Real Adapter；Mock Adapter 继续保留在测试环境。发布物、数据库迁移、配置、数据集和回滚包都使用明确版本。

**Tech Stack:** Electron、Pi SDK、SQLite 或经过证明需要的 PostgreSQL、真实 OCR/B2B/ERP Adapter、受控 Secret Store、监控告警、版本化 Dataset。

**Spec:** [E 阶段](E_Canary小流量真实写入教程.md)、[DATA-03](DATA-03_数据集校验与版本发布教程.md)、[测试手册](03_测试验收与排错操作手册.md)

## Global Constraints

- “生产 Mock=0”只指生产执行路径；测试 Mock 和回归 Scenario 必须保留；
- 发布前必须成功恢复备份；
- 最终验收使用冻结的 acceptance split，不允许现场调参后重算同一报告；
- 生产密钥不进入安装包、源码、日志或交付文档；
- 上线期间人工业务流程继续可用；
- 一个人维护不承诺无法兑现的 7×24 人工响应；
- 无法安全完成的任务转人工，不追求 100% STP。

---

## 进入条件

```text
[ ] E 阶段退出门全部通过
[ ] 业务和安全负责人批准上线
[ ] 生产变更窗口已确定
[ ] 人工回退流程可立即启用
[ ] 发布版本、数据集版本和数据库版本已冻结
[ ] 上线前备份完成并恢复验证
[ ] 监控和告警已验证
[ ] 生产联系人和停止权限已确认
```

## Task F1：生产真实组件清单

在 `docs/07b2b/evidence/phase-f/production-components.md` 记录：

| 能力 | 生产实现 | 凭证引用 | 健康检查 | 降级方式 |
|---|---|---|---|---|
| Invoice Source | Real | profile id | 可拉取只读样例 | 暂停新任务 |
| OCR | Real | profile id | 健康样例 | 转人工或备用 Provider |
| Invoice Verify | Real | profile id | 状态查询 | 转人工 |
| Supplier/PO | Real | profile id | 只读查询 | 暂停匹配 |
| B2B | Real | robot profile id | 登录与状态查询 | Kill Switch + 人工 |
| ERP WriteBack | Real | service profile id | 测试回写状态 | Outbox 等待人工处理 |
| Audit Storage | Real | system config | 写入和读取 | 停止生产写入 |
| Monitoring | Real | system config | 测试告警 | 人工巡检并降低流量 |

- [ ] 🏢 每个外部系统确认 Owner、支持时间、限流和变更通知方式。
- [ ] 👤 每个健康检查实际运行一次。
- [ ] ⛔ 任一生产组件没有降级方式时不全量上线。

## Task F2：ERP 回写和最终一致性

**Files:**

- Create: `packages/adapters/src/erp/real-erp-writeback.ts`
- Create: `packages/domain/src/writeback-outbox.ts`
- Test: `packages/domain/test/writeback-recovery.test.ts`

流程：

```text
B2B 明确提交成功
→ 保存 externalId
→ 生成 ERP WriteBack Outbox
→ 尝试回写
→ 成功：记录 ERP 结果
→ 失败：保留 Outbox，告警并按策略重试
→ 重试耗尽：转人工，不撤销已经成功的 B2B 事实
```

- [ ] 🤖 回写失败不能把 Job 错误标成“B2B 未提交”。
- [ ] 🤖 重试使用独立幂等键。
- [ ] 👤 在测试环境演练 B2B 成功、ERP 失败、恢复后回写成功。
- [ ] 👤 保存点：`feat: make erp writeback recoverable`。

## Task F3：发布包和配置

**Files:**

- Create: `docs/deployment/production-install.md`
- Create: `docs/deployment/production-config.md`
- Create: `docs/deployment/rollback.md`
- Create: `scripts/preflight-production.ps1`

预检脚本必须验证：

- 应用版本；
- 数据库迁移版本；
- 必需目录；
- 可用磁盘空间；
- 配置完整但不输出密钥；
- 外部系统健康检查；
- Kill Switch 当前状态；
- 备份时间；
- 数据集版本；
- 时钟和时区。

运行：

```powershell
npm run build
powershell -ExecutionPolicy Bypass -File .\scripts\preflight-production.ps1
```

正确结果：Build 成功，Preflight 所有检查为 PASS，输出不包含真实凭证。

## Task F4：数据库迁移、备份和恢复

- [ ] 👤 停止新任务并等待写操作达到安全点。
- [ ] 👤 创建上线前数据库备份。
- [ ] 🤖 在备份副本上先运行迁移。
- [ ] 👤 启动旧版本读取迁移前备份，确认回滚可用。
- [ ] 👤 在隔离目录恢复数据库、Audit 和一个脱敏附件，完成一次任务查询。
- [ ] 把实际耗时记录为 RTO，把能够恢复到的最近时间记录为 RPO。

如果恢复失败，不执行生产升级。

## Task F5：安全和隐私验收

至少检查：

```text
Renderer 无密钥访问
日志无密码/Token/Cookie
截图脱敏与访问控制
真实发票不在 Git
机器人账号最小权限
账号停用和轮换可执行
生产数据库和备份加密
数据保存期限已确认
外部 OCR/LLM 使用获得批准
依赖许可证和安全告警已检查
```

- [ ] 🏢 让信息安全或系统 Owner 确认生产访问方式。
- [ ] 👤 用无效账号验证权限拒绝和告警。
- [ ] 👤 开启 Kill Switch，确认写 Tool 全部停止。

## Task F6：性能和恢复性验收

使用脱敏回归数据运行目标业务峰值。指标至少包括：

- 每小时处理量；
- 平均和 P95 总耗时；
- OCR、LLM、B2B 各步骤耗时；
- 内存稳定性；
- 磁盘增长；
- 外部限流；
- 应用崩溃后的 Job 恢复；
- 网络中断；
- OCR 不可用；
- B2B Timeout；
- ERP 回写失败。

目标不是压出最大数字，而是证明实际峰值下不会重复提交、丢任务或失去 Audit。

## Task F7：最终验收

固定版本：

```text
应用版本
Pi SDK 版本
数字员工版本
Prompt/Skill 版本
Tool/Workflow 版本
数据库 Schema 版本
Dataset 版本
```

使用 DATA-03 冻结的 acceptance split，一次性运行：

```powershell
npm run eval:acceptance -- --dataset dataset-v1.0 --split acceptance --app-version 1.0.0
```

验收报告必须包含：字段准确率、任务决策准确率、STP、人工介入率、严重错录、重复提交、Audit 完整率、成本、平均/P95 时间、失败案例 ID 和已知限制。

- [ ] 👤 对失败样本只记录，不现场修改代码后覆盖第一次报告。
- [ ] 🏢 业务 Owner 确认报告和已知限制。
- [ ] 报告保存到 `docs/07b2b/evidence/phase-f/final-acceptance.md`，敏感附件保存在加密目录。

## Task F8：最终交付包

交付清单：

```text
[ ] 源码和明确提交 ID
[ ] 可安装应用包及 SHA-256
[ ] 依赖锁文件和许可证清单
[ ] 不含密钥的配置模板
[ ] 数据库迁移和回滚脚本
[ ] 部署、升级、卸载和回滚说明
[ ] 真实组件与接口清单
[ ] 凭证 profile 清单，不含密钥值
[ ] Dataset manifest、版本和授权说明
[ ] 单元、集成、E2E、性能、安全测试摘要
[ ] 最终验收报告
[ ] 业务规则、异常矩阵和人工操作 SOP
[ ] 监控、告警和 Kill Switch 手册
[ ] 备份恢复演练记录
[ ] 已知问题和暂不自动化场景
[ ] 业务培训和单人运维培训记录
[ ] 外部系统 Owner 和问题升级路径
```

## Task F9：上线与回滚窗口

上线顺序：

```text
冻结发布版本
→ 上线前备份
→ Preflight
→ 安装新版本
→ 运行数据库迁移
→ 保持 Kill Switch 开启
→ 只读健康检查
→ 1 个白名单任务人工批准
→ 核对外部结果
→ 恢复到批准流量
→ 观察
```

回滚触发条件与 E 阶段自动停止规则相同。回滚应用版本时不得把已经发生的真实提交回滚成数据库中的“未提交”。必须先对账外部状态。

## F 阶段完成标准

```text
[ ] 生产执行路径无 Mock
[ ] 测试 Mock 和固定 Scenario 仍保留
[ ] 所有真实组件有健康检查和降级方式
[ ] 最终验收获得业务确认
[ ] 生产备份恢复成功
[ ] 回滚演练成功
[ ] 安全和隐私检查通过
[ ] 交付包完整且 hash 已记录
[ ] 人工业务回退仍可用
[ ] G 阶段运维日历已启用
```

完成后系统才算正式交付；随后进入 G，而不是停止维护。
