# 离线评测设施

`runner/materialize.py` 将 Case 条件转为输入和受控初态。`input` 可投影给产品；`harness` 属于可信控制器。Gold、检查项及评分答案不进入两者。物化成功不代表产品已执行或通过；实际产品、SDK、ParsedDocument 接入器缺失时保留依赖限制。

```powershell
python agent-eval/src/runner/materialize.py audit --project . --output agent-eval/data/manifests/materialization
python -m unittest discover -s agent-eval/tests -v
```

审计默认读取当前数据根，可用 `--data-root` 指定发布前暂存根。输出必须是该质量根 `manifests` 内的新目录。报告给出实际物化数量及不支持场景，产品运行数保持 0。文本文件使用字符串；PNG 文件采用 `{encoding: "base64", data: "..."}`。执行器必须解码二进制文件，并在隔离临时根创建文件。`fixtureValidation` 是结构自检证据，`actualImportExecuted`/`actualAccessExecuted` 不代表已执行。

## 可信证据入口

`runner.evidence.load_evidence(run_root, manifest, trusted_adapters)` 读取真实证据字节，核对受控路径、摘要、Case/版本/Run/适配器身份。`manifest` 包含 `caseId`、`caseVersion`、`source:{kind,runId,adapterVersion}`、`evidence:[{kind,artifact,sha256}]` 和 `observationArtifact`。每个 JSON 证据文件必须包含相同 Case/版本/source；主要文件的 `observation` 提供待评分事实。

`trusted_adapters` 是执行器持有的 `adapterVersion -> callback(manifest, decoded_artifacts)` 注册表。回调必须用执行器自己的运行登记、受信采集渠道和质量侧固定定义验证来源及动作、对象、载荷关联；返回 `True` 才能放行。模型提供的适配器名称、文件摘要或 runId 无法代替这个验证。本模块不注册产品适配器，也不把本地写出的模拟文件当真实产品运行。

加载器返回有完整性封印的观测。`grade(case, observation, gold=None)` 拒绝普通 JSON 的 `product_run` 声明及加载后被改动的观测。测试可明确使用 `grader_self_test`，但其结果范围始终是评分器自检，不能计入产品成绩。

## 判定与对照

`oracle.checks` 定义每项 `checkId`、`dimension`、`required`、`hardConstraint`、`assertion:{path,op,value}`、`evidenceRequirements:[{kind,required}]` 和 `ruleStatus`。必要检查未实现或证据缺失会阻断整例通过。旧 `assertions` 仅供局部诊断，不足以得到整例通过。已确认必要项失败优先保留 FAIL，同时公开未解决项。

安全结果独立输出 `modelBehavior`、`platformControl`、`actualConsequences`。基础合法对照使用 `scenarioRole=control`，不能再依赖其他对照。攻击对照必须来自独立加载的可信观测，在 manifest 的 `normalControl` 中传入；其主要证据包含 `observation.evaluatedCase`。注册回调须验证该定义与质量侧固定 Case 一致。评分器核对 `normalControlRefs` 的 Case/版本、同 split 和 `controlPairKey` 并重新评分，拒绝直接填写的 pass。

Gold 仍由质量控制器独立提供。抽取只自动比较已核验固定版本的字段及明确来源定位；整页或语义支持需要另行复核。所有结果保持 `formalAcceptanceEligible=false`，内容审核、适用范围和实际产品运行等门槛仍由后续正式执行链完成。
