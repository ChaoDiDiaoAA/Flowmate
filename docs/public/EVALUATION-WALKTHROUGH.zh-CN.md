[评测指南](EVALUATION.zh-CN.md) · [基准制作](../EVALUATION-BENCHMARK.md) · [模块命令](../../agent-eval/README.md)

# 评测闭环操作教程

本教程沿 Trace → Dataset → Evaluator → Experiment → Regression → Improvement，走完一次从真实任务到回归判断的操作。原始 Full62/Smoke14 保持不变，Gold/Bad/Regression 候选由真实轨迹产生，正式发布后再明确选用。

**历史21步实拍与本次发布补拍分别保留。** 22:47:55的21张图只读取已有记录、预览 Full 计划，步骤17当时仍为发布准备；步骤20为旧实验blocked Gate，步骤21为Full372未执行的预览。之后真实用户仅批准 QA 候选AA修订2，检查通过后已发布到自定义基准 Full；本次新增步骤15、17的只读补拍，未再次反馈、校验或发布。原基线Smoke的v4/v5均已中断，当前按用户要求停止评测；未完成记录不作为完整84次比较或Full372验收。此次默认Luna/max角色调整仅修改配置、代码和文档。

截图来自独立本机用户数据目录，只读连接主仓库已有评测数据；它不冒充原产品 Activity 的用户目录。实际时间、请求、业务 ID、状态和字符范围见[本轮 capture-index.json](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/capture-index.json)，完成时点为 UTC `2026-10-27T22:47:55.812Z`（北京时间2026-10-28）。[初次19张原件及其时点](../screenshots/evaluation-walkthrough/capture-initial-20261028/capture-index.json)保持原样；[本轮首次尝试的20张原件及第21步定位失败记录](../screenshots/evaluation-walkthrough/capture-final-20261028/capture-index.json)也独立保留。各 SVG 引用同目录的**未修改原始 PNG**，只增加矢量编号箭头及说明，不改原像素、页面文字或状态。下文只解释实际存在的箭头，未入画面的目标不补造。

[人审与发布补拍 index](../screenshots/evaluation-walkthrough/capture-human-published-20261028/capture-index.json)时点为 UTC `2026-10-28T01:02:49.849Z`，只执行 `candidate.show` 与 `benchmark.list`，新增两组原PNG/SVG；旧21张不覆盖。

## 1. 准备本机环境与私有配置

在当前仓库根目录准备依赖和桌面运行环境，创建忽略提交的 `agent-eval/configs/.env`。同名系统环境变量优先。核对当前 checkout 与实际应用对应，避免在另一仓库执行命令后截取当前应用。

![步骤1：本机 Evaluation 入口，准备态](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/01-environment.svg)

图中①指实际 Evaluation 闭环入口。**实拍状态：preparation-only**；读取 `settings.get`，没有运行 doctor，不能据此判断环境就绪。

## 2. 配置默认被测模型与实验对照组

默认被测 Agent 与候选真实重放使用现有网关 `http://127.0.0.1:8767/v1` 的 `gpt-6-luna`，API `openai-completions`、reasoning `max`。在 `agent-eval/configs/.env` 设置 `FLOWMATE_EVAL_AGENT_MODEL=gpt-6-luna`、`FLOWMATE_EVAL_AGENT_API=openai-completions`、`FLOWMATE_EVAL_AGENT_BASE_URL=http://127.0.0.1:8767/v1`、`FLOWMATE_EVAL_AGENT_REASONING_EFFORT=max`；本机网关不使用 DeepSeek 密钥。

仅双模型实验的 control 保留 `deepseek-flash`、`https://api.deepseek.com/anthropic`、`anthropic-messages`，独立密钥为 `FLOWMATE_EVAL_DEEPSEEK_API_KEY`，不放进实验计划。原有双模型计划的 DeepSeek control 与 Luna/max candidate 保留。本次只修改默认角色、配置和文档，不执行评测、重放、挖掘或模型探针。

![步骤2：已保存的被测角色配置](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/02-subject-models.svg)

图中①指已读取的角色配置区域。**实拍状态：saved-record**；截图保留当时 DeepSeek 默认配置，不代表本次改为 Luna/max 后的当前配置；没有进行模型探针，也没有在图中证明两个实验 arm 均已运行。Luna 原生能力记录的输出容量为128000；现有网关 transport 上限为32768，两者分别保留。

## 3. 配置独立原生 Judge

选择 codex-cli、`gpt-6.1-terra`、reasoning `medium`，通过 `FLOWMATE_CODEX_EXECUTABLE` 指向实际 CLI。复用现有 ChatGPT 登录，不填写 HTTP Key/URL，不改全局 Codex 配置。使用真正的结构化 JSON 探针核对独立评分连接；探针结果与完整评分分开。

![步骤3：已保存的原生 Judge 配置](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/03-native-judge.svg)

图中①指当前 Judge 角色配置所在区域。**实拍状态：saved-record**；本次截图没有调用 Judge。另有真实 Terra/medium 校准记录：56项中53项计数一致，3项 validation 为 UNJUDGEABLE，误接受与误拒绝均为0；这不等于56项全部可判定。报告身份见文末实测表。

旧56项校准只覆盖 v3 rubric。主仓库随后为超过原生输入上限的大证据增加无损 `flowmate-judge-shared-text/v1` 分支，并在调用前确定 v4 rubric 格式模板；这是评分条件变化，不能把旧校准或此次旧条件 Smoke 追认为 v4 已校准。新探针只核验无损传输及结构化响应，见文末表。

## 4. 配置独立挖掘模型

使用 codex-cli、`gpt-6-luna`、reasoning `max`，与 Judge 共用 CLI 可执行路径，角色独立。确认挖掘配置不会覆盖被测 Agent。挖掘会真实调用模型；只在需要候选时启动。

![步骤4：已保存的挖掘角色配置](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/04-mining-model.svg)

图中①指当前挖掘角色配置所在区域。**实拍状态：saved-record**；没有启动或重复挖掘。角色配置与步骤13的已有候选结果分别核对。

## 5. 连接 Langfuse

填入 Langfuse 地址与项目凭据，使用连接检查确认实际服务和项目。连接成功不证明任何 Trace 已上传。本机 Langfuse 服务需要先实际启动并确认版本；源码版本、服务部署版本和 SDK版本分别记录。

![步骤5：已保存的 Langfuse 连接配置](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/05-langfuse-connection.svg)

图中①指当前 Langfuse 配置所在区域。**实拍状态：saved-record**；configured 只说明有配置，本次没有执行连接检查或打开 Langfuse 网页。已完成的真实产品 Trace 上传与独立回读见步骤12。

## 6. 分别开启采集、上传与自动挖掘

核对 **Capture product traces**、**Upload captured traces**、**Automatically mine candidates** 三个开关，分别对应 capture/upload/mining，默认关闭。为了手动观察本教程，可先只开 capture；需要远端核验时开 upload，需要自动挖掘时再单独开 mining。关闭某开关不会把其他开关当作已授权。

![步骤6：三个独立开关的已保存值](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/06-trace-switches.svg)

图中①为 Capture product traces，②为 Upload captured traces，③为 Automatically mine candidates。**实拍状态：三项均为 false**；本次只读取，没有开启或保存。已有历史 Trace 的存在不意味着当前开关开启。

## 7. 完成一条可独立核验的成功任务

使用适合留存的真实本地问答、发票候选或研究任务。保存原输入和材料，不为了成功重写用户问题。记录实际输出与业务回执，再用独立来源判断成功。Run completed 不自动代表质量 PASS，人工修改后的结果不能代替原模型产物。

![步骤7：查看已保存的源任务 Trace](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/07-success-task.svg)

图中①为原始 JSON 当前分块，②为实际字符范围与脱敏状态。Trace `8c5319ab-2681-42ed-8c24-06fd903def1c` revision 1，保存状态 `completed`、采集 `complete=true`。画面为字符0–32000 / 46331，未到末尾、未脱敏；**本次只查看已有任务，completed 不代替质量 PASS**。其成功支持与独立来源绑定见候选修订2及步骤16的真实回放记录。

## 8. 保留一条实际失败或实际阻断任务

观察一个真实失败、缺证据或基础设施问题并保留完整错误；不制造假响应或把受控 Provider 演示标成真实模型失败。区分 Agent FAIL、SDK/Provider/计费、Judge ERROR、采证缺口。没有遇到真实失败时写明未取得，不能编造。

![步骤8：真实发票任务失败的已有原始证据](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/08-failure-task.svg)

图中①为原始 JSON 当前分块，②为实际字符范围。FM-001 Trace `43a5944e-4c49-47a8-8337-435377d26aab` revision 1，状态 **FAIL**、采集 `complete=true`；原件3954487字符，约3.9 MB，当前仅展示0–32000。真实执行有三项必要断言失败，另保留 tool-arguments 诊断，未发生 ERROR。研究 FM-051 也已有真实 FAIL，工具接纳关闭；见文末报告。两者均不在截图时重跑。

## 9. 筛选并打开 Trace

在 Activity 选择实际 Run 后点击 **Open evaluation trace**，按当前用户数据目录及 Run/Session 身份打开关联产品记录；缺少来源归属或未开启采集时明确显示无记录，多条匹配时需选择原记录。Evaluation 本地列表的入口、状态筛选只作用于当前摘要页；可翻页或直接输入步骤7/8的 Trace UUID。时间范围仅用于 Langfuse 远端回读，不是本地列表的时间筛选。核对来源为 product/evaluation，Trace UUID和revision，以及关联 Session/Run/Trial；不能按相近标题猜测。Trace 的 **Open source Activity** 可回到其实际 Run。

![步骤9：实际 Trace 摘要列表与筛选控件](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/09-trace-filter.svg)

图中①为 Trace 列表，②为筛选控件。**实拍状态：当前页显示10条已有摘要，共10条**；其中包括 NOT_RUN、ERROR、FAIL、PASS 和 completed，均保留原状态，不能把列表全称为成功。本次隔离截图没有执行 Activity 跳转；实际产品关联仍须匹配 productRoot 与 Run/Session，不能仅凭数字 ID。

## 10. 检查根 Trace 的输入与输出

打开根节点，核对原始语言、空白、多轮次顺序、材料、模型配置与实际输入输出。核对 complete/gaps；若缺材料或请求，保留缺口并停止把它作为已证明的候选来源。Gold 不应在被测 Trace 中。

![步骤10：根 Trace 原件的首个字符页](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/10-trace-root.svg)

图中①为 Trace 原件分块，②为字符范围与脱敏状态。对应步骤7同一 Trace/revision，实际显示0–32000 / 46331。**采集 complete=true 与当前页 end of record=false 含义不同**；这张图没有声称全文已显示或所有材料均已逐项人工核对。

## 11. 检查子节点与业务回执

展开模型调用、工具、父子 Agent 和产物/回执关系。核对实际请求/响应与工具入参/结果，不只看工具名称。材料读取、进入模型请求、正确采用分别观察。没有子代理时记录不适用；不要画出虚构子节点。

![步骤11：原始轨迹事件所在字符页](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/11-trace-children.svg)

图中①指原始轨迹 JSON 分块，保存的读取范围为10621–42621 / 46331，未到末尾、未脱敏。范围控件因滚动未在本图内，capture-index 记录其实际值。**本次查看已有事件，不补造工具、子代理或回执；单页不能代表整条执行关系已验收。**

## 12. 上传并从远端回读

原始本机 product Trace 可显式上传，不重跑任务。Benchmark/evaluation Trace 使用原 Execution 的 Export/resend，保留原 Subject/Judge/score 树；平台导入副本不能用原 ID 再上传。写入结果未知先按原操作回读，再用时间窗口和分页核对根及子观察。平台回读独立保存为 `langfuse.json`，不覆盖本地 `trace.json`。

![步骤12：在 Flowmate 查看独立保存的真实 Langfuse 回读](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/12-remote-readback.svg)

图中①指新 canary `live-otel-canary-20261028` 的独立平台快照原始 JSON 分块，Trace 为 `69cacc1c-bd2c-43a2-bfdc-0d5ace09c024` revision 1。原 Export 的4个 OTEL观察、12个 score 共16项已 verified，再次查询未重发。保存回读时间为 UTC `2026-10-27T21:03:10.579Z`，平台快照自身 `complete=true`、gapCount=0；source/input 与本地一致，output 因 status/config 投影不同保留 `local-platform-content-diff`，不能把采集完整等同于与本地逐字段相同。本图读取字符16584–43450 / 43450，到末尾、未脱敏，本地原件未改。**本次没有再次 pull/upload；这是 Flowmate 中的回读画面，Langfuse Web 页面截图仍缺失。**

## 13. 从真实 Trace 挖掘候选

每次为实际 Trace 选择一种 kind：gold、bad 或 regression。需要不同类别时分别显式调用，各自记录 operation ID；当前 schema、界面和 CLI 不提供 all。记录源 revision、模型角色和实际请求结果。unknown 时查询原操作，rejected/needs-evidence 保留原因。挖掘 completed 只代表草稿已生成，不代表可运行或已发布。

![步骤13：查看实际挖掘候选的当前修订](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/13-mine-candidate.svg)

图中①为候选实际 revision/status。候选 `aa0d3e0d-9a49-4d0d-8d04-7a4955233ab2`，kind `gold`、revision **2**、status **validated**，源 Trace 为步骤7的 revision 1。来源/校验目标因滚动未入本图，未补箭头。**本次只读取既有候选，没有启动或重复挖掘，也没有发布。**

## 14. 核对独立预期与正负控制

检查候选原输入完全保留，Gold不是模型回答的复制。逐条打开独立材料原文与success/failure/answer绑定，查看scenario和目标断言。缺证明保留needs-evidence。Gold需原成功支持；失败类需原负例和独立正例。已覆盖Case条件不改并设置复用。

![步骤14：实际候选原件中的独立预期](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/14-independent-expected.svg)

图中①为候选原件分块；Gold 与 validation 确实存在。实际字符范围122–32122 / 61811，未到末尾、未脱敏；这是引用与绑定的阅读入口，不能把一页当作全部控制已审核。已覆盖条件用 `reuseCaseId` 原样复用；同一原输入、场景、标签及材料下修正预期或评分，须显式填写 `reviseCase:{id,version}`，version 必须是目标当前 CaseVersion。改变任务目标应为新 Case，不能通过新 ID 绕过已有覆盖的复用或修订。

## 15. 添加对应目标的人工反馈

分别选对 case-quality、run-feedback、trace-feedback或candidate-review。填写真实reviewer、verdict和note；对回答good不等于批准入库。反馈绑定目标与版本/视图和operation ID，保留原评分。

![步骤15历史画面：当时只有 Agent 反馈，尚待真人审核](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/15-human-feedback.svg)

历史图中①为候选修订与状态。当时只有反馈 `0288a761-4571-47d8-a7e9-b21baec58b1a`，**source=agent、verdict=needs-work**；该旧图不记为真人批准。候选 reason 仍保留草稿时原文，当前回放状态应读独立保存的 validation/replay。

![步骤15补拍：读取已保存的真实用户批准](../screenshots/evaluation-walkthrough/capture-human-published-20261028/15-human-feedback.svg)

补拍①为已保存反馈结果区域，②为原始 source/verdict/批准身份。真实用户回复“同意，检查通过后加入Full”，仅授权候选 `aa0d3e0d-9a49-4d0d-8d04-7a4955233ab2` revision2。当前 validation PASS、干净Host真实回放PASS及条件一致经复核后，已保存 `source=human`、`verdict=approve`，批准ID `b8208dac-d14b-4399-afa1-0ebddd5661d3`。Agent建议仍保留，没有覆盖原评分；本次补拍只读，没有提交反馈。

## 16. 编辑候选并重新校验

带expectedRevision提交必要编辑，观察revision增加、旧validation/approval失效；以新版本重新检查schema、来源、控制和可加载性。查看replay独立状态；未运行模型就是NOT_RUN，受控PASS不能标为真实模型PASS。

![步骤16：读取候选修订2已保存的校验与回放内容](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/16-edit-validate.svg)

图中①为实际候选原件中 validation 所在字符页，范围3941–35941 / 61811，未到末尾、未脱敏。Gold 修订2在移除 Subject Host 的 Gold 依赖后，新真实 DeepSeek 回放 **PASS**，报告 ID `candidate-replay-de71c2e3-6107-407f-a8fe-0f4eaede9c47`，执行完整、scoring complete。旧回放另存，不追认为干净 Host 证据。**本次截图只读取保存结果，没有再次编辑或校验；Agent 修订与真实回放不替代真人审批。** 编辑仍需先完整加载未脱敏原件，不能保存分块预览。

## 17. 真人批准当前版本并正式发布

真人审核当前有效版本，确认approve反馈后，明确benchmark ID、候选/批准ID和Smoke成员，再发布。查看published版本与case/gold/review/scenario/materials快照。候选列表出现和validation PASS都不等于已发布。

![步骤17历史画面：当时发布列表为空](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/17-publish-benchmark.svg)

历史图中①为当时保存记录列表，**preparation-only、items=[]**；这只是22:47:55前后的旧状态。validated 本身仍不等于 published。

![步骤17补拍：读取已发布的自定义基准 revision1](../screenshots/evaluation-walkthrough/capture-human-published-20261028/17-publish-benchmark.svg)

补拍①为只读发布列表结果，②为真实revision、成员数与Smoke成员数。已发布 **`flowmate-trace-benchmark@1`**，发布时间 UTC `2026-10-28T01:00:10.298Z`，operation `d11935d3-a391-4f13-91cb-0470369782d9`。唯一成员为上述AA修订2对应的 **FM-063 CaseVersion1**；该自定义基准 **Full1、Smoke0**，原始 baseline Full62/Smoke14不变，也未改变当时Smoke运行的选集。加载已发布版本及同operation重复回读已核对成功，未重复创建版本；本次补拍没有调用publish。

用户批准仅覆盖此QA候选，不包含其他候选或Git提交、推送。Regression `14a648d0-9b80-41f8-b97c-0370b9b21c4e` 的干净Host真实回放仍FAIL，未批准、未发布。此处“加入Full”指自定义基准的成员选择，**不表示已运行Full372或证明整体质量改善**。

## 18. 预览并运行三重复 Smoke 对照

计划中声明模型轴，选择明确baseline revision或已发布benchmark revision，Judge/Gold固定、其他条件相同。先看preview的实际成员与费用含义，再运行两模型三重复。原始Smoke14为84个被测Trial，发布成员另计。保留全部真实结果与每个arm的Execution IDs；失败不能用后来成功替换。

![步骤18：第三轮 Smoke 的实际运行中记录](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/18-smoke-comparison.svg)

图中①为保存状态区域，②为原始实验状态及 arm 身份。本图于 UTC `2026-10-27T22:47:53.352Z` 只读打开 `flowmate-model-smoke-20261028-v3`：**当时** experiment=`running`，DeepSeek arm=`running`，Execution `agent-1793140811517-fcc4b004`；Luna arm=`pending`。之后该实验已停止，下表记录最新状态。计划仍为84次，本图不是当前仍运行、84次已完成或改善结论。

各轮原始记录分别保留，不用后一次成功覆盖前一次失败：

| 轮次 | 实际状态与证据边界 |
|---|---|
| v1 `flowmate-model-smoke-20261028` | stopped、CLI exit2；DeepSeek42完成（业务8 PASS / 20 FAIL / 2 UNJUDGEABLE，研究12 FAIL）；Luna3次 FAIL/PASS/FAIL，其余39次未执行。FM-005 原 `TaskBudgetTimeout`，最终 Host cleanup stopped/closed 均 true、无 scene 活进程；wrapper 首次快照失败后 stopUnconfirmed 粘滞，首次异常未保存，不猜原因。45次实际结果保留，无自动重试。 |
| v2 `flowmate-model-smoke-20261028-v2` | 因发现 Subject Host 打包包含 Gold 依赖而主动中断，仅4个完整结果已保存；后续可能处于准备阶段，不能补造未保存的 close。experiment/report 收尾元数据仍未完成，不能作为正式质量或完整比较证据。 |
| v3 `flowmate-model-smoke-20261028-v3` | UTC `23:17:29` stopped、CLI exit2。业务30次完整：5 PASS、24 FAIL、1 UNJUDGEABLE，Judge error为0；研究仅6次完整。保存36个完整 Trial及下一项部分事实，Luna未启动，Full未开始；没有完整双模型比较、Baseline或质量Gate结论。22:47:55截图保留当时running状态。 |
| v4 `flowmate-model-smoke-20261028-v4` | 主仓库D在采证拆分修复后启动，已保存33次结果（业务30完整、研究3已保存）后中断，进程已不存在；原experiment仍running、研究endedAt为空，不能当作运行中或完整比较。Full未开始，旧截图保持历史原貌。 |
| v5 `flowmate-model-smoke-20261028-v5` | 已按用户要求停止，保存2次结果；原experiment仍running、report endedAt为空，保留中断事实，不补写完成或取消回执。没有后台评测进程，后续不自动恢复。 |

v3下一项为 FM-057 repetition2。独立数据库证明 Run1 的 planning 已完成、Run2 研究阶段以 `tool_budget_exceeded` 失败，随后两轮采证各5秒超时。保存结果中的默认 `execution.started=false` **不能证明该项没有启动**；本轮保留已实际执行的部分事实，不补成完整 Trial。最终 Host close 的 `stopped=true`、`closed=true`，scene无活进程。

v3当时的尾部采证与业务预算混用、重复 snapshot 及超时边界问题已完成拆分修复；首次未保存的异常仍不猜具体RPC。业务120秒预算未调大，长全文采证与其分离；stopOnly 快速停止证明仍限5秒，只有确认真已停止后才进入有界 capturing。采证 singleflight 在3个消费者共享时共119次RPC；安全副本离线验证快停177ms、完整采证7514ms。保留原始全文，不通过删减证据或增加 actor 预算换取完成。

修复后的 targeted 实测分别保存：`capturing-deepseek-fm057-20261028` 已完整执行及采证，started=true、execution=completed、scoring complete、Judge complete、Host closed/stopped 均true，无capture gap；质量仍 **FAIL**，指标覆盖6/12。`capturing-luna-max-fm005-20261028` complete=true、stopped=false、started=true，保留原预算触发的 `task_timeout` **FAIL**，最终Host closed/stopped 均true、Judge complete。这里执行记录的stopped字段与Host停止证明分别报告，不把预算失败改写成能力通过。

本轮采证拆分已完成同一OCR阶段的增量复查。工程全套为1031个测试、142个文件：1029 pass、2 optional skip、0 fail；两个可选跳过项此前已按指定原文件单独验证。build、typecheck均退出0，桌面E2E为9/9。这些工程证据不替代上述真实质量结果，也不证明v4或Full已完成。

业务30次的1260个 span/score 平台核对最初为966/1260；匹配器修正因果父子关系与时间包含关系的处理后，只查询原 target 已核对1260/1260，**没有新增POST**。修正于v3停止后同步主仓库，10项工程测试、52条断言通过。此结果仅说明该业务执行的原平台记录核对完整，不代表研究部分、双模型Smoke或模型质量通过。

动态机会 Judge 项的0/0/0须有有效声明、完整响应及见证，才仅在比较投影中显示 N/A，原成绩保持；纯非必要且不在正式/关键集合的 diagnostic 标为 `gated=false`，必要失败仍参与 Gate。主仓库后来增加的 v4 无损传输分支不回写这次旧条件 Smoke，也不删除其原始失败或不可判断结果。

## 19. 显式建立与选择 Baseline

只从完整实测且可比的arm建立Baseline；已知Agent FAIL可作为已测起点，ERROR/缺失不可。填写明确ID，检查原Execution关联和条件快照。Baseline列表不自动选latest，不覆盖已有ID。

![步骤19：实际 Baseline 列表为空](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/19-explicit-baseline.svg)

图中①为实际 Baseline 保存记录列表，**items=[]、total=0**。本次仅执行 baseline.list，没有创建 Baseline；因此尚无可选 Baseline ID，不能用单题预检或空目录冒充完整比较基线。

## 20. 查看 Gate 的 pass、fail 与 blocked 边界

对选定Baseline和arm检查Gate，逐条读取原因和证据引用。关键指标及逐题通过次数零退步，已发布回归每次全过，泄漏/禁止副作用零，其他质量项按方向最多下降0.02。3/3→2/3失败；2/3→2/3不因失败轮次不同失败。缺评分/条件不符为blocked，Smoke请求Full release也blocked。

![步骤20：读取旧实验真实 blocked Gate，未执行新检查](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/20-gate-results.svg)

图中①指完整原始 Gate JSON 的可视区域。实际读取 Gate `gate-f5c6b79d-724b-4b63-9f41-7ba894138071`，所属旧实验 `flowmate-model-smoke-20261028`；保存状态 **blocked、exitCode=2**，字符0–1006 / 1006，未脱敏。原记录 `fullRelease=false`，理由仍逐项保留：明确 Baseline 文件缺失、Smoke范围不足以证明Full、缺少完整实测证据。旧实验已停止，此 Gate 是证据不足的阻断演示，**绝非模型质量 pass/fail 结论**。本次没有调用 gate.check，也没有创建 Baseline。

## 21. 完成 Full、检查发布范围并归档证据

完整发布使用Full选集与真实模型证据。两模型原始Full62三重复为372 Trials，发布成员另计。结果不完整、ERROR或不可比则保留blocked，不能用Smoke作完整发布结论。保存计划、全部执行/证据、比较、Baseline/Gate和远端回执，核对链接后记录实际状态。关闭不再需要的采集/上传/自动挖掘开关。

![步骤21：Full372 的真实只读预览，尚未执行](../screenshots/evaluation-walkthrough/capture-final-r3-20261028/21-full-and-archive.svg)

图中①为实际 `experiment.preview` 返回区域，②为计划总数。读取既有 `runs/acceptance-plans/acceptance-full.json`，只在界面填入计划并点击 Preview：plan ID `flowmate-model-full-20261028`，baseline revision1 / Full，62题、两个arm、三次重复，`totalTrials=372`。**实拍状态：preparation-only**；没有实际 Full Execution ID，未点击 Run、未导出、未归档或进行Full release验收。画面上方仍可见前一步旧 Gate，不属于此 Full 计划的运行结果。

## 本次图文对应的已保存实测证据

下表记录实际已完成的有限范围。截图动作只读；模型调用、校准和远端操作发生在各自原记录中，不能从本次截图数量推导完整基准通过。

| 记录 | 实际结果与范围 |
|---|---|
| `native-terra-medium-calibration-20261027T181653886Z` | 独立编写的受控参考样本，真实调用 Terra/medium 校准56项；53项计数一致，3项 validation UNJUDGEABLE；误接受0、误拒绝0。仅覆盖 v3 rubric，不是人工标注，也不能表述为全部56项通过或已校准 v4。 |
| `native-terra-shared-text-7e08cb12-3e9d-49f6-8ebb-802a64c77228/probe.json` | 主仓库真实 Terra/medium 传输格式探针：来源为旧 FM-024 的2037986字符输入；无损共享文本后请求939118字符，exact decode 与原输入一致。完整返回6行，包含一项0/1，`validationErrors={}`。`independentAccuracyCalibration=false`：仅证明该次无损传输与响应格式，不是新增独立或人工质量校准。 |
| `live-luna-terra-preflight-20261028-v3` | 真实 gpt-6-luna/max Subject + Terra/medium Judge，单题 FM-002 PASS，1次逻辑 Judge 提交。不是84/372实验。 |
| `candidate-replay-be38c90a-2f09-4fbb-8c5b-5969572da2fb` | QA修订2旧真实回放PASS；保留历史，不追认为干净Host证据，当时尚待真人批准。当前批准与发布另记下一项及步骤15/17。 |
| `candidate-replay-de71c2e3-6107-407f-a8fe-0f4eaede9c47` | 干净 Subject Host 新真实 QA 回放PASS，候选AA修订2当前条件一致已复核；真实用户批准后已发布 `flowmate-trace-benchmark@1`，FM-063 v1、Full1/Smoke0。批准 b8208dac-d14b-4399-afa1-0ebddd5661d3，发布operation d11935d3-a391-4f13-91cb-0470369782d9。本轮仅补拍保存结果，未调用模型。 |
| Regression 挖掘 operation `4f4199af-3eb2-4795-b086-337b71e2fac4` | 真实 Luna 调用77.7秒后 completed，生成候选 `a195b5c9-3c15-4d40-954c-309c0c02917d`（生成时 draft，校验后当前 status=blocked）。原材料 `replayReference:null` 且缺少独立正例，模型省略 Case/Gold/scenario，保留10条引用；校验 BLOCKED、回放 NOT_RUN。这是待补证据草稿，不是可运行 Regression。原 Bad unknown 操作保留，未重试。 |
| 派生发票 Trace `9158cc9e-e96e-40b0-bc49-ec185d83f3d7` | 从冻结的 FM-001 证据及4份逐字节相同的公开材料重建 source 路径；旧 Trace `43a5944e-4c49-47a8-8337-435377d26aab` 未改写。派生来源保留，不能冒充另一条新产品执行。 |
| Regression 候选 `14a648d0-9b80-41f8-b97c-0370b9b21c4e` | 真实 Luna 修订1的错误 Gold 被阻断，原件留在 `candidate-v1.json`。Agent 修订2严格复用 FM-001 CaseVersion1及原 Case/Gold/scenario。来源快照与隔离修复后重新校验 PASS，负控制 FAIL、正控制 PASS；干净 Host 新真实回放 `candidate-replay-0d880d75-c58e-4427-96fc-e8e7909bac90` 为质量 FAIL。旧 `candidate-replay-af2ca04a-f919-4469-b690-18b84de7d5d7` 另存，不替代新证据；未发布、无人审，不能凭 schema/控制 PASS 声称发布完成。 |
| FM-001，Trace `43a5944e-4c49-47a8-8337-435377d26aab` | 真实发票执行 FAIL，三项必要失败及 tool-arguments 诊断；无 ERROR，原始大体积证据保留。 |
| `live-research-canary-20261028` | 真实 FM-051 FAIL，工具接纳关闭；无 ERROR。 |
| 产品 Trace `433a1351-264f-47f4-a461-f9f2ad887918` | 真实 OTEL 上传 verified、v2回读 complete、gaps=[]；独立 `langfuse.json`，本地原件未被覆盖。 |
| `live-otel-canary-20261028` | 新真实单题 PASS；原 Export 的16项为4个 OTEL观察及12个 score，全部 verified，再次查询未重发。v2回读的 source/input 一致；output 因 status/config 平台投影不同保留 `local-platform-content-diff`，本地原件未改写。Export 验证与平台投影差异分别报告；没有把旧截图当成本次画面。 |
| 旧 evaluation Trace `d93f56f1-7f60-4090-b504-a340f31c4aec` | 历史 export 曾 complete；严格投影规则随后变化，不能作为当前规则下完整导出的证明，需新执行另验。 |
| Smoke v1 / v2 / v3 / v4 / v5 | v1 stopped45；v2因Gold隔离中断，仅4个完整保存且结束元数据未收尾；v3 stopped/exit2，保存36完整及FM-057 repetition2部分事实；v4保存33次后中断，v5保存2次后按用户要求停止。原running/endedAt空值不代表进程仍在运行。Full未开始，各轮不能混算为完整实验。v3业务30的1260个span/score已只查询原target完整核对，未新增POST。详见步骤18。 |

原生 CLI 的 cached/reasoning 等实际用量字段保留在原始 metadata；扁平用量只列 input/output，避免重复累加。未知内部重试或费用仍为未知。后续 Smoke、Full、Baseline、Gate 和正式发布有真实 ID/结果后再补本教程，不以计划、准备界面或单题结果提前填结论。

## 如何解释最后的记录

保存目录或completed Run不能替代质量通过。工程测试通过不代表真实模型稳定；独立Judge可用不代表全部评分无错；发布候选不代表改善已测量。最终应分别列明工程检查、原生探针、受控演示、真实任务、远端回读、Smoke、Full、Baseline与Gate的实际结果。

不自动重放非受控Shell、真实表单或外部写入，不用新一轮模型调用掩盖未知写入结果。遇到阻断时记录实际原因与已保存证据，之后恢复操作仍沿原ID回读。
