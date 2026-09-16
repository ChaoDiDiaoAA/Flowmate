# 离线评测设施

## 目录职责与模块分派

| 位置 | 职责与输入输出 |
|---|---|
| `runner/materialize.py` | 读取固定 Case 与获准资料，返回产品 input、可信 harness 计划、物化状态与缺失依赖 |
| `runner/evidence.py` | 从受控 run_root 验证真实证据字节、身份、版本和可信来源，返回受完整性保护的观测 |
| `graders/observations.py` | 比较固定 Oracle/Gold 与已验证观测，返回逐项结果、缺证据和整例结论 |
| `contracts.py` | 必要检查、硬约束、规则状态与结果聚合的共享契约 |

Case 实际位于十五个 `data/cases/<harnessModule>/` 目录。读取入口使用 `case-catalog.json` 的 path 或 `harness_paths.canonical_case_path`；不得由旧 category 拼接物理路径。category 仍用于既有业务/机制分派，新场景使用 `harnessScenarioId` 选择固定计划。跨模块场景只有一份 Case，相关模块通过元数据和检查项引用。

## 输入物化

`runner/materialize.py` 将 Case 条件转为输入和受控初态。`input` 可投影给产品；`harness` 属于可信控制器。Gold、检查项及评分答案不进入两者。物化成功不代表产品已执行或通过；实际产品、SDK、ParsedDocument 接入器缺失时保留依赖限制。

```powershell
python agent-eval/src/runner/materialize.py audit --project . --output agent-eval/data/manifests/materialization
python -m unittest discover -s agent-eval/tests -v
```

审计默认读取当前数据根，可用 `--data-root` 指定发布前暂存根。输出必须是该质量根 `manifests` 内的新目录。报告给出实际物化数量及不支持场景，产品运行数保持 0。文本文件使用字符串；PNG 文件采用 `{encoding: "base64", data: "..."}`。执行器必须解码二进制文件，并在隔离临时根创建文件。`fixtureValidation` 是结构自检证据，`actualImportExecuted`/`actualAccessExecuted` 不代表已执行。

### 新增 Harness 场景的参数

| 参数 | 含义与读取边界 |
|---|---|
| `harnessScenarioId` | 固定场景定义键；未知场景应拒绝物化 |
| `input` | 唯一可向产品投影的获准任务内容；不包含预期、Gold 或判据 |
| `harness.initialState` | 控制器在隔离环境建立的执行前状态；不是本轮观测 |
| `harness.commands` | 需由真实产品适配器触发的动作序列，例如恢复会话、提交输入、取消 |
| `harness.faults` | 受信适配器在指定位置注入的故障，不能作为模型输入提示正确答案 |
| `dependencies` / 支持限制 | 实际执行所需产品入口、SDK、模型和可信证据适配器；物化成功不清除此依赖 |
| `caseSummary` | 中文输入、触发和预期摘要，仅供评测侧理解用例 |
| `subcapabilityRefs` / `oracle.checks[].requirementRefs` | 子能力导航与断言实际支撑的条款；目录归属不能替代检查覆盖 |

例如：“旧绑定的输入不得消费”先建立 Session 当前 generation 和带旧绑定的输入，再通过适配器提交。控制器采集实际拒绝结果、输入消费记录与原生事件；评分器据这些证据判断。直接把期望的 `consumed=false` 写入 JSON，只能用作明确标识的评分器自检，不能构成产品运行。

原生历史以产品数据库中的完整 SDK 历史为权威来源。恢复、分支和压缩必须通过适用阶段的真实入口运行，物化器不实现另一套产品逻辑。新增场景的逐项配置和中文预期见数据手册附录 C。

## 可信证据入口

`runner.evidence.load_evidence(run_root, manifest, trusted_adapters)` 读取真实证据字节，核对受控路径、摘要、Case/版本/Run/适配器身份。`manifest` 包含 `caseId`、`caseVersion`、`source:{kind,runId,adapterVersion}`、`evidence:[{kind,artifact,sha256}]` 和 `observationArtifact`。每个 JSON 证据文件必须包含相同 Case/版本/source；主要文件的 `observation` 提供待评分事实。

`trusted_adapters` 是执行器持有的 `adapterVersion -> callback(manifest, decoded_artifacts)` 注册表。回调必须用执行器自己的运行登记、受信采集渠道和质量侧固定定义验证来源及动作、对象、载荷关联；返回 `True` 才能放行。模型提供的适配器名称、文件摘要或 runId 无法代替这个验证。本模块不注册产品适配器，也不把本地写出的模拟文件当真实产品运行。

加载器返回有完整性封印的观测。`grade(case, observation, gold=None)` 拒绝普通 JSON 的 `product_run` 声明及加载后被改动的观测。测试可明确使用 `grader_self_test`，但其结果范围始终是评分器自检，不能计入产品成绩。

## 判定与对照

`oracle.checks` 定义每项 `checkId`、`dimension`、`required`、`hardConstraint`、`assertion:{path,op,value}`、`evidenceRequirements:[{kind,required}]` 和 `ruleStatus`。必要检查未实现或证据缺失会阻断整例通过。旧 `assertions` 仅供局部诊断，不足以得到整例通过。已确认必要项失败优先保留 FAIL，同时公开未解决项。

安全结果独立输出 `modelBehavior`、`platformControl`、`actualConsequences`。基础合法对照使用 `scenarioRole=control`，不能再依赖其他对照。攻击对照必须来自独立加载的可信观测，在 manifest 的 `normalControl` 中传入；其主要证据包含 `observation.evaluatedCase`。注册回调须验证该定义与质量侧固定 Case 一致。评分器核对 `normalControlRefs` 的 Case/版本、同 split 和 `controlPairKey` 并重新评分，拒绝直接填写的 pass。

Gold 仍由质量控制器独立提供。抽取只自动比较已核验固定版本的字段及明确来源定位；整页或语义支持需要另行复核。所有结果保持 `formalAcceptanceEligible=false`，内容审核、适用范围和实际产品运行等门槛仍由后续正式执行链完成。
