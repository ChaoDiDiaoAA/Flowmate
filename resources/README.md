# Flowmate 作者资源

Skill 属于 P11。具体文档位于 `resources/skills/<skill-id>/`，每个 ID 一个当前作者包，目录中直接放 `resource.json`、`SKILL.md` 和按需参考文件，不含 `v1/` 一级。版本身份仍由 manifest 的 `version` 与规范化内容哈希记录。Prompt 作者包同样使用 `resources/prompts/<id>/`，直接放 `resource.json`、`prompt.md`；manifest 的 version 与旧选择内容哈希保持不变，固定 Run bundle 的内部版本目录不变。

Skill Hub 位于 `packages/core/src/skill-hub/`。加载、依赖检查、显式路由、启停、固定副本和渐进读取复用同一服务。`list_skill_resources`、`read_skill_resource` 的自定义 ToolDefinition 位于 `packages/employee-invoice/src/tools/`；Agent 工具只访问原 Run 固定的、当前范围可用的 Skill。

## 编写与启用

1. 创建直接 ID 目录；`SKILL.md` 的原生 frontmatter `name` 必须与目录及 manifest ID 相同，description 说明适用条件。保存类 SOP 设置 `disable-model-invocation: true`。
2. `resource.json` 使用现有 ResourceManifestSchema：列举真实文件、工具/Skill/Extension 必要依赖。按最终 UTF-8 字节计算每个文件的 bytes 与 SHA-256；manifest 自身不列入 files。
3. 正文写步骤和完成条件；分支规则放 references，正文写明何时读取。读取脚本文件只取得文本，不自动执行。业务证据来自当前发票工具，Skill 文档不作为字段来源。
4. 在 Skills 或 Settings → Skills 点击 Refresh resources，查看名称、描述、依赖和诊断，显式启用。新增资源默认关闭；原已保存选择继续沿用原身份。
5. Ready 表示已启用且所有必要条件通过；Partial 表示已启用但缺项（可为 0/n）；Disabled 表示未启用。列表显示不赋予执行权限，Run 仍按真实工具/材料/扩展范围重新检查。

## 更新、回退与历史

修改作者正文、参考文件或依赖后，更新 manifest 版本和文件 hash，再刷新并显式选择新 ref。一个 ID 不同时保留多个作者版本；回退需从版本控制恢复对应文件和 manifest 后刷新、选择。内容改变而复用旧选择会给出变化或缺失诊断。

活动 Run 与历史查询继续读取 `runtime/resource-bundles/<bundleHash>/skills/<id>/<version>/` 的不可变副本。该内部版本路径用于保留旧 Run 证据，作者目录去掉 `v1/` 不迁移或重写历史 Bundle。重启重新核作者选择，旧读取不自动重放。

## 当前技能库

当前共十六份。页面将原十一份介绍按原文全文匹配为固定英文译文，新五份介绍直接使用英文；只改变列表/提示/详情的介绍展示，不修改原作者内容、Pi 索引或旧选择。原介绍与关键词仍支持中文搜索，英文译文也参与搜索；未知或后续变更介绍按原文显示，需维护对应展示译文。

| Skill | 用途 |
| --- | --- |
| invoice | 原有发票字段整理 SOP |
| invoice-evidence-discovery | 页、块、表及资料缺口定位 |
| invoice-header-extraction | 头字段状态、规范化与来源 |
| invoice-line-item-extraction | 明细、列映射与跨页片段 |
| invoice-amount-reconciliation | 精确金额与舍入核算 |
| invoice-source-audit | 引用身份与原文支持关系 |
| invoice-missing-info-review | 缺失、无法辨认及补充资料 |
| invoice-conflict-review | 有来源替代值与未解决冲突 |
| invoice-candidate-comparison | 候选身份及字段/行差异 |
| invoice-candidate-save | 用户显式要求的校验与保存 |
| invoice-form-readiness-review | 填入前复核报告，不执行 Fill |
| invoice-party-role-review | 买卖方名称、税号及标签归属 |
| invoice-date-currency-review | 日期顺序和币种标签歧义，不换汇 |
| invoice-line-calculation-review | 逐行数量、单价、净额与税额核算 |
| invoice-candidate-issue-triage | 按实际检查与问题等级整理复核顺序 |
| invoice-review-handoff | 有来源的人工复核交接摘要，不导出 |

工程检查使用现有资源契约、真实 SDK、SQLite、受控 Provider 与 Electron 测试。它们证明加载和交付，不证明模型语义遵循；语义效果沿统一 Agent 评测。作者内容不携带正式 Case/Gold、密钥或业务秘密。

## 模板与 Subagent 角色（2026-10-09）

`resources/prompt-templates/{invoice-evidence-review,parallel-invoice-review}.md` 为 Pi 原生 Markdown Prompt Template，使用 `/<name> <arguments>` 展开一次；生成指令不证明已经委派。`resources/subagents/{invoice-evidence-checker,general-analyst}.md` 为角色作者文件，name/description/tools frontmatter，正文作为独立子 AgentSession 的系统提示词。用户新建及内置覆盖保存到产品已解析的 `<runtimeRoot>/subagents/<id>.md`；无 v1 层。Extensions → subagents → Plugin details → Manage agents 可新建、编辑和查询保存身份，变化供后续 Run 使用，创建角色不自动开启插件。

开启 subagents 后，自然语言让主 LLM 自主调用 Agent；`/subagent <role-id> <task>` 经真实 pi.registerCommand 路由；两个模板也要求真实 Agent 调用。每次委派独立 Pi SDK loop 会话，工具复用父注册实现并重新绑定子 Run 的 PURE/READ 范围。最多四个前台子执行；共享父预算，禁止背景、嵌套及写操作。Assistant 卡片反映真实子 Run，可单子停止或用 Root Stop 停止全部。

索引补充 Readiness/计数/真实缺失项；Skill 原生索引、补充段及读取指导总计16KiB，不全量注入正文。两个 Skill 工具仍在 employee-invoice/src/tools，分页和实际请求包含分别取证；黄色标签只显示缺失真实依赖。
