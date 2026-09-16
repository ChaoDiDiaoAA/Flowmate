# Flowmate Harness 数据重组与补齐实施计划

## 一、已确认目标与交付约束

依据产品总方案和 Agent 评测总方案，把实际用例迁入十五个 Harness 功能目录，补充具体子能力的正常、失败、边界等变化，并同步生成、物化、评分、校验、审核、覆盖与文档链路。仅改文档、增加标签或建立空目录不能完成计划。两份源方案保持原内容，不通过修改要求来消除缺口。

唯一当前质量根为 `agent-eval/data/`。共享 2,902 份去重原票、1,414 份来源标签、1,200 份已发布且 humanVerified 的结构化 Gold、600 套模拟业务包。保留既有 5,577 个 Case 的身份和业务语义，在此基础上追加具体机制场景；新增数量由实际场景与清单统计，不以凑数量为目标。不建立 v1/v2 等并列目录。

当前分支为 codex/final-dataset。直接在用户指定的 `D:/code/Flowmate` 工作，原因是此处有约 1.08 GiB 被 Git 忽略的数据及用户修改的源方案；不创建缺失这些资料的独立副本。数据先写项目内 `data/.preparation-stage/` 的新暂存根，校验后发布。旧当前内容的归档、摘要、Gold 发布与审核链全部保留。

本轮不恢复已退役的外部验真、ERP 回写、产品内 OCR/Parser、自动拆合票、额度/多级财务审批、强制两人分离、复杂员工创建配置 UI 或第二任务证明。保留外部解析、原件证据、A2 收货/价格/数量/余额、按需匹配、人工修订/澄清、具体 B2B 确认及接管。

## 二、十五个物理目录

| cases 下目录 | 主责 |
|---|---|
| foundation | 契约、配置、启动、输入接入与组装 |
| agent-runtime | Provider、原生 Loop、任务决策与整票抽取 |
| tools | 注册、参数、Handler、Gateway、结果、取消与权限 |
| events | 原生事件、流式消息、投影、Trace 与诊断证据 |
| sessions | 身份、输入队列、续接、分支、绑定、取消与关闭 |
| context | 当前资料、获准输入、快照与实际模型调用关联 |
| memory | 数据库完整原生历史、持久化完整性与恢复使用 |
| compaction | 原生压缩、重复触发、失败取消与事实保持 |
| workflow | 匹配校验、StepAttempt、Waiting、修订与评估快照 |
| prompt-skills | Prompt、任务目标、SOP、资源选择、固定版本与注入 |
| extensions | 原生扩展、Hook、命令、装载、停用与清理 |
| subagents | 真实委派、命名槽位、只读范围、父子取消与预算 |
| actions | 预览、正式确认、Browser/B2B、持久动作、防重与权威核对 |
| operations | Host、环境凭证、发布、预算停写、备份与清理 |
| eval-infrastructure | 数据契约、Trial、评分、合法对照与报告分母 |

每例唯一 harnessModule 决定 `cases/<harnessModule>/<id>.json`；relatedHarnessModules 关联其他模块，不复制用例。category 保留旧业务/机制分派，不能再拼接目录。177 个旧场景族使用显式主责映射，未知族报错。

## 三、已确定的实现决策

1. 保留既有 5,577 个 ID、split、原票和业务语义；修改后的 Case 升版，登记旧版本、摘要、路径及归档，旧内容审核不继承。
2. 新场景以稳定 harnessScenarioId 对应结构化初态、commands、faults、expected、forbidden 和 evidence。纯机制例使用 synthetic_only、sampleId=null、无无关原票输入。
3. 每例增加中文 caseSummary.input/trigger/expected、模块关联和 subcapabilityRefs，说明测什么、怎样触发和如何判断。
4. 新增合成种子按合法对照组统一置 development；不冒充未暴露留出验收样本。对照需独立真实证据，不接受填写 pass。
5. 从方案解析固定来源记录；本次解析基线为 321 项，含 77 项存储原子条款，最终以 requirements 清单及其来源摘要为准。MOD/RT 提供导航，RTC/RTX/HC 等细化要求；仅将具体断言支撑的条款链接到检查项，禁止将所有 MOD 标签批量复制到每条检查。
6. 每模块保存职责、来源、成员、子能力、检查、阶段、F/A/B 模式、变化和缺口。目录有文件不等于完整覆盖。最早阶段与实际启用前提必须一致；未准备模式继续显式保留。
7. 物化仅生成获准 input 和可信 harness 控制计划。Gold、Oracle、expected 不进入产品输入，不把预期复制为观测。原生历史、事件、扩展、委派和动作结果必须通过真实产品/SDK 采证。
8. 来源、Gold、业务包和审核记录保持内容与身份。acceptedGold=1200 表示已发布字段答案及澄清预期的人类审核依据，不表示产品验收通过；actualProductRuns 不因迁移增加。
9. 重建 inventory、case/module catalog、splits、views、requirements、coverage、review queue、audit batches、materialization 和 preparation report，所有数量、路径和摘要从当前成员计算。
10. 刷新数据 README 时保留完整 Gold、状态、输入、Oracle、审核和证据字典，更新十五目录与计数，扩展附录 A/B 并增加具体场景参数、配置和值的中文附录 C。不能用泛化字段标签取代原有说明。
11. 90 个 RTC、6 个 RTX 和 77 个存储原子要求均须至少有直接断言，验证器拒绝遗漏。26 项设施与治理规范单独登记 `facilityObligations`，保留未冻结、待审核、缺实际证据等限制；它们不增加产品覆盖。
12. 正常对照的能力依赖必须是被测场景依赖的子集，且阶段不得更晚。新增场景的自然语言禁止项保留必需、未实现的来源核验检查；待真实输入投影和动作主体证据规则实现前，整例不能通过。

## 四、实施批次与接收台账

| 批次 | 工作 | 接收依据 | 本轮状态 |
|---|---|---|---|
| H0 基线 | 清单、源方案、资产与审核历史固定 | 摘要与当前字节一致，旧内容可追溯 | 已核验；原清单及受保护资产均保留历史摘要 |
| H1 目录 | 十五模块、旧族映射、统一路径、可读字段 | 旧 ID 无丢失重复，每例仅一处，旧目录无活动 Case | 已完成；5,577 个旧 ID 保留，15 个目录、5,807 个当前 Case |
| H2 细项 | 需求提取、新场景、对照、阶段及 F/A/B | 各变体有具体输入、操作、禁止行为、证据与断言，缺口公开 | 已完成材料登记；新增 230 例，90 RTC/6 RTX/77 存储原子条款有直接检查，治理限制单列 |
| H3 设施 | 物化、审核、验证、可信评分与负例 | 新路径可读、答案不泄露、缺规则/证据不能通过 | 93 项设施测试＋90 项数据工具测试通过；未实现的禁止项阻断通过 |
| H4 暂存 | 迁移、清单、覆盖、队列及完整手册 | 共享资产/历史摘要保持，全部当前引用可解析 | 已完成；暂存生成、历史核对及发布前全量校验通过 |
| H5 发布 | 校验后发布并复验当前根 | 发布前后全量检查通过，回滚依据完整，无伪造实际运行 | 已完成；发布后全量复验通过，重复迁移不修改数据，真实产品运行 0 |

本表为数据工程台账，不能当产品验收结论。测试计数来自本轮实际工具输出；真实产品运行数保持 0，新增和改版 Case 的内容审核保持 pending。

## 五、验证与接收要求

- 共享资产、Gold 发布、审核与运行历史：核对原身份、原字节、原状态及历史绑定关系。
- 物理路径：十五目录、一例一处、旧 5,577 ID 保留、无旧类别活动目录；清单、用途、阶段、BM、模块和审核引用完整。
- 新增语义：正常、失败、边界等变体有可观察条件差异；场景数、语义键和重复实例分别计数。
- 来源映射：摘要、原文、行号、阶段、模式、检查与合法对照均一致；不以通用 status 断言代表完整条款。
- 可信输入：产品只读 input，harness 留在控制器；Oracle/Gold/expected 不泄露；缺产品/SDK/适配器时保留依赖。
- 评分负例：错误行为、缺证据、伪造运行声明、错版本、旧确认和失败对照均不能通过；已确认失败不被缺证据掩盖。
- 状态与统计：材料、审核、物化、真实运行和通过独立；设施自检不能记入产品分母。
- 文档：模块职责、MOD/RT、输入输出证据、参数含义、中文示例、Gold 状态与完整附录一致。

## 六、执行入口及完成边界

```powershell
python agent-eval/tools/migrate_harness_data.py stage --project . --output data/.preparation-stage/harness-review
python agent-eval/tools/migrate_harness_data.py verify --project . --output data/.preparation-stage/harness-review
python -m unittest discover -s agent-eval/tools -p "test_*.py" -v
python -m unittest discover -s agent-eval/tests -v
python agent-eval/tools/migrate_harness_data.py publish --project . --output data/.preparation-stage/harness-review
python agent-eval/tools/verify_invoice_data.py --project .
```

stage 仅准备新的项目内暂存目录。verify 的 --output 指暂存根，省略检查当前根。publish 使用已检查暂存根发布，随后再次核验当前根。流程、参数与职责见 [制作方案](data-preparation.md) 和 [设施说明](../../src/README.md)。

工程接收必须同时满足物理迁移、原 Case 保留、新增具体场景、细项追溯、设施链路、全量检查与文档一致。即使工程检查通过，内容复核、完整产品/SDK 执行、未准备模式和正式阶段验收仍需实际证据分别完成。

## 七、本次交付记录（2026-09-16）

| 项目 | 实际结果 |
|---|---|
| 当前数据根 | `D:/code/Flowmate/agent-eval/data` |
| Harness 目录 | 15 个；旧七类活动目录已迁出，category 仅保留兼容分派 |
| Case | 5,807 个＝5,577 个原身份＋230 个新增具体场景 |
| 场景计数 | 407 个场景族、3,746 个语义键、2,061 个额外重复实例 |
| 共享资产 | 2,902 份原票、1,414 份标签、1,200 份已发布 Gold、600 套业务资料保留 |
| 需求 | 321 条来源记录；另有 1,455 条具体断言契约，不能混称新增源规范 |
| 直接检查 | 90 RTC、6 RTX、77 存储原子条款均有直接检查项；不代表全条款已运行或所有 F/A/B 模式已完成 |
| 治理 | 26 项设施与治理条款单列入口与缺口，不计产品 Case 覆盖 |
| 离线物化 | 2,210 个具体夹具＋230 个适配器计划；其余 Case 的物化依赖明确保留 |
| 真实产品运行 | 0；无产品成绩、黄金表现或失败成绩被制造 |
| 测试 | `unittest discover -s agent-eval/tests -p 'test*.py'`：93 项通过；`-s agent-eval/tools`：90 项通过 |
| 幂等 | 发布后重跑 stage 返回 `already_migrated`，不重复生成或覆盖历史 |
| 发布后全量检查 | `verify_invoice_data.py --project .` 返回 `file_and_reference_checks_passed`；核对 19,377 个产品文件、14,082 个质量文件及全部摘要和引用 |

原清单 SHA-256 为 `bd2b1b9eaceb61fc6dede84695cad34e3dd1485df538a821f2cddb02e4631c6d`。其完整内容保存在同名 `manifests/history/*.zip`，`harness-migration.json` 固定原路径、原摘要、新路径和保留资产。两份方案摘要分别为产品 `e4869321f3241ed74eb9ecca3b4ad1a4295df7fea4eec4dca0297acbd60b6a76`、评测 `da2b6ef22ad3eba38206f02b1d337bcd6e25d69c2b5178e8a5728ba25ac6d751`。

发布前审查修复了正常对照能力高于被测场景、未实现禁止项未进入整例评分、模块清单遗漏尚无检查的 RTC 导航，以及新增参数缺少说明的问题。将余下 RTC 与存储治理缺口补为具体场景后，重新生成、测试并发布；中间稿不作为当前数据。

当前待完成项为修改内容的人工复核、近重复与留出曝光审查、正式 Benchmark/运行冻结、真实产品/SDK 及证据适配器和未实现的禁止行为核验规则。这些状态均保留在清单中；既有 Gold 审核效力不受此次目录迁移影响。
