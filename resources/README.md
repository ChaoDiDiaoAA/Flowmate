# Flowmate 作者资源

Skill属于P11。作者包位于resources/skills/<skill-id>/，每个ID一个当前包，直接包含resource.json、SKILL.md及必要参考文件，无v1作者层；Prompt同为resources/prompts/<id>/。当前目标ResourceRef只有kind／id／version，manifest schemaVersion=2；运行副本的内部版本目录保持可读。

Skill Hub 位于 `packages/core/src/skill-hub/`。加载、依赖检查、显式路由、启停、固定副本和渐进读取复用同一服务。`list_skill_resources`、`read_skill_resource` 的自定义 ToolDefinition 位于 `packages/employee-invoice/src/tools/`；Agent 工具只访问原 Run 固定的、当前范围可用的 Skill。

## 编写与启用

以下是本轮目标契约，代码／资源迁移已实现，回归验证结果见P11实施计划§6.1，完整门禁尚未通过；历史SHA与旧成绩保留原义。

1. 创建直接 ID 目录；`SKILL.md` 的原生 frontmatter `name` 必须与目录及 manifest ID 相同，description 说明适用条件。保存类 SOP 设置 `disable-model-invocation: true`。
2. resource.json使用v2 ResourceManifestSchema，声明真实path／bytes和必要Tool／Skill／Extension依赖；按最终UTF-8字节核bytes，不计算或保存内容摘要，manifest自身不列入files。
3. 正文写步骤和完成条件；分支规则放 references，正文写明何时读取。读取脚本文件只取得文本，不自动执行。业务证据来自当前发票工具，Skill 文档不作为字段来源。
4. 在 Skills 或 Settings → Skills 点击 Refresh resources，查看名称、描述、依赖和诊断，显式启用。新增资源默认关闭；原已保存选择继续沿用原身份。
5. Ready 表示已启用且所有必要条件通过；Partial 表示已启用但缺项（可为 0/n）；Disabled 表示未启用。列表显示不赋予执行权限，Run 仍按真实工具/材料/扩展范围重新检查。

## 更新、回退与历史

旧资源会话不可续跑，原native历史及业务事实保留可查，不能从当前作者文件补造原内容或重放。packages与skillIndex完全相同才复用已发布UUID，复用前核bundle.json、manifest和全部文件权威字节；相同组合保留空闲SDK复用语义，组合改变仍沿原关闭／重建路径。

修改正文、参考文件或依赖后更新明确manifest版本，刷新并显式选择新ref。同版本作者内容与已保存权威字节直接比较，替换旧内容会诊断resource_version_changed；回退从Git恢复对应文件和声明后重新选择。

活动Run及历史查询读取runtime/resource-bundles/<bundleId>/中的原运行副本，bundleId为UUID，bundle manifest为v2。DB020将文件内容按owner_kind／owner_id／relative_path保存到唯一managed_file_contents表并迁移可取得旧内容，旧路径和历史关联保留；缺原正文的旧仅摘要证据显示gap，不自动重放。

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
