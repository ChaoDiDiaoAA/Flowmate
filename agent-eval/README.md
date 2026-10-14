# Flowmate Agent 评测

评测数据及保存产物无哈希，公开版本固定为 v1。已有真实运行记录保留；本次 Smoke 修复与 Badcase 工程修订只做数据、工程和受控验证，不追加真实 Agent／Judge、校准或平台上传。质量结论以对应 Execution 的实际条件和证据为准。

## 填写配置

唯一配置为 agent-eval/configs/.env，保存评测专用 Agent、Judge 和 Langfuse；文件忽略提交，不另建模板。首次使用时按下面内容创建：

```dotenv
# 必填：评测专用 Flowmate Agent 接口根地址，保留服务要求的路径
FLOWMATE_EVAL_AGENT_BASE_URL=
# 必填：评测专用主模型密钥，不读取通用或桌面凭据
FLOWMATE_EVAL_AGENT_API_KEY=
# 必填：实际执行 Case、决定工具调用和生成回答的主模型名称
FLOWMATE_EVAL_AGENT_MODEL=
# 可选：接口协议，默认 openai-completions
# 支持 openai-completions、openai-responses、anthropic-messages、google-generative-ai
FLOWMATE_EVAL_AGENT_API=openai-completions
# 可选：与主模型相同的接口协议，默认 openai-completions
# 旧 FLOWMATE_JUDGE_PROVIDER=anthropic / openai-compatible 在未设置 API 时仍兼容
FLOWMATE_JUDGE_API=openai-completions
# 使用 Judge 评分时必填：服务接口地址
FLOWMATE_JUDGE_BASE_URL=
# 使用 Judge 评分时必填：评分模型名称
FLOWMATE_JUDGE_MODEL=
# 使用 Judge 评分时必填：独立评分密钥，不继承 Agent 密钥
FLOWMATE_JUDGE_API_KEY=
# 可选：请求超时，单位毫秒，默认 180000
FLOWMATE_JUDGE_TIMEOUT_MS=180000
# 显式平台操作时必填：Langfuse 地址及项目凭据
LANGFUSE_BASE_URL=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
```

主模型 URL／Key／Model 只用于评测隔离 Host，CLI 的 --model／--api／--base-url 可临时覆盖；同名系统环境变量优先于文件。桌面设置、根目录 .env 和通用模型凭据不参与。DeepSeek 的 /anthropic 地址须配 anthropic-messages；OpenAI 格式地址配 openai-completions。

原生模型能力优先从 Pi SDK 精确匹配，未收录的 DeepSeek 从官方模型元数据读取并固定，不猜测容量或另设 Token／温度额度。Judge 独立配置，Anthropic 必填输出字段使用服务声明的原生能力。主模型、Judge 和平台密钥不交叉使用，不进入报告或日志。

## 校验数据

```bash
bun run eval -- dataset validate --dir agent-eval/src/datasets
bun run eval -- doctor --backend local
```

数据校验无需凭据。doctor 检查配置、数据和本机运行环境，必要时只读模型元数据，不生成回答或评分；未就绪返回非零状态。基线三个 TS 数据文件、附加专项、场景和 Fixture 的详细制作约定见 docs/eval。本地Agent评测由CLI启动独立本机Host，不需要Docker或镜像。

## 执行评测

工程 E2E 使用测试环境和模拟模型，不读取真实评测凭据：

```bash
bun run test:e2e
```

以下命令会调用真实 Agent 和 Judge，有实际模型费用；本次工程修订不追加执行：

```bash
bun run eval:smoke
bun run eval:full
```

Smoke 共14题（业务10＋研究4），Full 共62题（业务50＋研究12）。按业务→研究顺序执行，每题默认一次，两组各保存一个 Execution／报告，并输出对应 ID 和路径。普通失败继续执行；取消或停止未确认则阻断后续 Trial 和下一组。退出码0表示必要自动评分通过，1表示失败／错误／执行不完整，2表示必要评分待判，人工验收独立。

Judge按Case的适用语义判据调用，不按Case数量强制调用。FM-028的精确号码、零工具、无Skill及无写入由本地检查判定，不生成语义计划，也不读取或准备Judge配置；其他61题各保留与原目标对应的语义判据，满足触发及证据条件后最多合并一次生成。FM-006的明细字段本地核验，但独立原行来源仍保留Judge。`--judge required`只要求选集中适用的必要语义评分可执行；纯确定性单题无需Judge凭据。`--judge off`保留必要语义项未测，不据此判通过。

终端默认显示全局题目序号、Case ID、环境准备／Agent执行／停止清理／评分／保存阶段。阶段开始以 `▶` 标记，使用单调时钟每60秒以 `⏳` 提示当前阶段及累计等待时间（60秒、120秒等）；切换阶段重新计时，结束后停止提示。60秒仅控制日志频率，不改变任务或 Judge 超时。

Agent结束后显示 `✅ Agent执行成功` 或 `❌ Agent执行失败`，超时、取消、未启动分别以 `⚠`、`⏹`、`⏭` 标明；Run completed、业务终点和质量通过分别核验。评分结束后显示 `✅ 通过（PASS）`、`❌ 失败（FAIL）`、`❌ 错误（ERROR）`、`⚠ 未判定（UNJUDGEABLE）` 或 `⏭ 未运行（NOT_RUN）`，并保留原因；业务 FAIL 同时有 Judge ERROR 时追加简短异常，详细 Schema／原响应保存在报告。每题保存成功后以 `💾` 显示状态、耗时和 `evidence/<trial-id>/`，业务组结束立即显示报告路径。进度写入 stderr；run／Smoke／Full结束不自动打印整段JSON，完整结果保存到report.json，显式status可查看。

## 查看或上传结果

```bash
bun run eval -- status --execution-id <ID>
bun run eval:upload -- --execution-id <ID>
```

Smoke／Full 始终本地执行，填写 Langfuse 配置不会触发上传。两组结果按各自 ID 单独上传；重复上传命令只补传已有结果，不重跑 Agent 或 Judge。兼容维护入口 resend --report <绝对路径>，与 --execution-id 二选一。

新 Execution 根据 Dataset 声明全集保存到 `agent-eval/runs/business/<execution-id>/`、`research/<execution-id>/` 或 `mixed/<execution-id>/`；Smoke／单题选集不改变归属。目录包含 snapshot.json、report.json、逐Trial evidence 和派生 badcases.json／badcases.md。artifacts/、review.json 和 export.json 只在有实际业务产物、真实反馈或导出尝试时保存；校准在 `runs/calibration/<id>/summary.json` 及同目录 Badcase 文件，Case 审核在 `runs/case-reviews/review.json`。

查看、比较、补传、审核和平台入口共享按 ID 查找，兼容旧 `runs/<execution-id>/` 与 `calibration-runs/<id>/`；同 ID 多处存在明确报冲突，不选最新或静默合并。既有两个 Execution 迁移完整目录，保留原始记录、ID、参数和分数，不重跑或重评。完整目录见[实施手册 §8.2](../docs/eval/05_Flowmate_Agent评测分阶段实施与操作手册_v1.md#eval05-directory-tree)，文件职责与生成条件见[§8.3](../docs/eval/05_Flowmate_Agent评测分阶段实施与操作手册_v1.md#eval05-runtime-files)。

`evidence/` 下每个 Trial 都有独立子目录，多个 Case 和重复尝试不会平铺或共用证据文件。取消、停止不明或运行异常时，终端显示原因及已有报告位置；仍在等待、单题已保存或已有目录均不表示整批评测通过。用 `status` 核对执行与评分状态；`pending` 表示尚未完成评分。

trial 保存实际 InitialInput／附件与后续输入；events.jsonl 保留运行事件和 Run spans，详细工具参数、结果及关联以 observation.json 为准。原候选按本题模型、目标 Run 及成功提交回执核验，UI 当前选择、人工修改／接受独立记录；不能用人工最终结果代替原模型成果。

Badcase 是报告层自动派生的 `flowmate-badcase-index/v1` 复核候选，与原分数和真实反馈独立。已发生 Trial 的 FAIL／ERROR／UNJUDGEABLE 和评分异常进入候选，计划未启动的 NOT_RUN 排除；有证据的 PASS 异常、恢复后通过、人工分歧和比较退步可补充候选。索引保存失败警告不改原判定；`status` 从原报告／证据只读重建候选视图，零模型／平台调用、不回写文件，索引不自动上传 Langfuse。实际归因与修复范围记 `agent-eval/records/<batch>/issues.md`，reruns.csv／exposure.csv 仅在对应真实事件后创建。

**Smoke后如何执行专项：** badcases.json／md是待核验索引，不是可运行数据集。用户或Agent核验任务、Gold、评分器和证据后编辑专项声明，离线校验→必要Judge校准→单题→完整专项→显式重复→基线Smoke；不增加命令，也不自动付费执行。专项结果按新Execution保存到runs/business或research，由报告dataset.id及regressionOrigins关联原失败；完整分阶段命令、停止条件和方法引用见[07 §5.1](../docs/eval/07_Flowmate_Langfuse接入与评测执行操作手册_v1.md#platform-badcase-suite)。

附加专项集由 `src/datasets/badcase/` 维护Case／Gold／Review引用及来源关联，不追加到默认Full62／Smoke14或`--dataset all`。当前业务专项 `flowmate-badcase-business-v1` 收录FM-045，研究专项 `flowmate-badcase-research-v1` 收录FM-051；FM-020／024因任务要求与通用完整字段／明细判据有范围歧义暂缓，原Case和旧分数不改。首批为工程核验，不代表独立真人认可或真实复测成功。

```powershell
bun --no-env-file run eval -- dataset validate --dir agent-eval/src/datasets/badcase
# 后续真实验证显式运行，业务／研究分别产生新的Execution：
bun --no-env-file run eval -- run --dataset flowmate-badcase-business-v1 --selection full --judge required --backend local
bun --no-env-file run eval -- run --dataset flowmate-badcase-research-v1 --selection full --case FM-051 --judge required --backend local
```

专项仅支持full或单题，拒绝smoke／holdout；空专项在创建Execution前报“暂无可运行成员”。新Trial的`partition:badcase`、`regressionOrigins`和`executionKind`用于质量侧追溯，不进入Agent输入。`status`的`regressions`视图核对收录和实际reruns；受控尝试标记controlled，不能计作真实稳定效果。报告完成保存后，实际启动的专项Trial才登记来源批次reruns.csv；幂等登记，失败独立告警，不改原成绩。稳定证据还须匹配来源Case身份／版本和目标指标集合；status保留实际metricIds及matchesCurrentTarget，目标改变后的旧尝试不计当前稳定。稳定验证另行显式`--trials 3`，全部尝试／必要判据及目标指标通过且无评分故障，CSV与保存事实一致才认可；不是自动重试。已有业务失败、工程修复、收录和真实效果分别维护，专项不宣称独立holdout或总体发生率。

Judge通过Pi SDK provider生成评分。Judge 复用现有 Pi SDK ModelRuntime.completeSimple、模型目录和原生能力解析；模型、凭据与主 Agent 独立，不装配业务工具。FLOWMATE_JUDGE_API 显式优先，未设置时兼容旧 PROVIDER 的 anthropic／openai-compatible 映射，均未设置时默认 openai-completions。默认及本次采用的超时为180000毫秒，可显式覆盖；取消有效，SDK 自动生成重试关闭，每 Trial 最多一次生成。

### 2026-10-14 Smoke 评分协议修订

新生成沿业务／研究固定模板返回按指标 ID 组织的 JSON：results 各项含 metricId、counts（numerator／denominator／unassessable）及 failures（opportunityIndex／code）；研究比例由 atoms／links／chains 见证在本地计算。只接受完整 JSON 或一个完整 Markdown 围栏包住的 JSON，不从解释文字中截取对象、不修补错误计数。分母、范围、来源和计数逐项严格校验；单项缺项／重复／计数错误只影响该项，研究见证错误只影响依赖项；根结构不可识别或未知指标身份使本次 Judge 无效。每 Trial 最多一次生成；旧 r/f、packed 及 HTTP 按原格式和提示身份只读解释。

数值评分复用仓库精确十进制工具，比较合法规范值，1 与 1.00 等价；字段覆盖 quantity、unitPrice、netAmount、taxRate、taxAmount、totalAmount。税率规范值使用百分数，10% 对应 10，不能将 0.1 自动修正。原值、规范值与 present／missing／ambiguous 状态分别保留；原始逗号金额不因替换字符串自动通过，未知格式不猜、缺失不填零。

调查阶段 read／query 返回的完整 evidenceRef 可直接用于 Claim，包含确认计划及原始来源 Run／ToolCall；规划阶段引用为 null，确认后查询取得。工具反馈精确说明必填、允许字段、UTF-16 要求及 Report full／partial 合法值和必要条件，模型可在同一预算内纠正并保存 partial。引用与身份严格核验；已完整采证且确认无当前 Report 才计算已知缺失，采证不完整保持未知或错误。402／余额或计费拒绝保留原服务错误与可核用量，归运行基础设施，不直接判 Agent 能力失败。

执行开始保存参与运行的文件清单和实际内容条件，结束在内存比较；仅 Git 提交／dirty 元数据变化不使执行失效。实际文件变化保留原指标，整组标记失效并保存变化路径与原因，终端一次明确说明。持久产物继续无 hash／指纹。

先文档、再实现和受控回归；真实 Judge 校准、代表性单题和 Smoke 另行执行并生成新 Execution。协议 ERROR 未解决不进入质量比较，工程夹具通过不证明真实模型遵循率。旧 Execution 保持只读，产品 FAIL、采证缺口与 Judge 故障分别记录。


## Trial次数、Case指标及重复诊断

CLI统一--trials N（默认1，范围1–20），旧--repeat启动前拒绝。Case定义不加repetition／trialId；它们位于Trial记录。内部repeat／repetition和历史报告／CSV兼容。Smoke、Full、单题及专项共同支持；Full --trials 5计划310个Trial，Smoke为70。每次Trial显示结论，最终保存后每Case打印自己的适用指标一次，必需未测项仍显示，stderr不打印整段JSON。trialStatistics独立记录pass@k／pass^k及波动，不修改39项公式；旧status可只读派生，不重评分。完整命令、字段及解释见../docs/eval/06_Flowmate_Agent评测数据集制作实施与操作手册_v1.md §9.1–9.4。受控测试不证明真实业务稳定性。
