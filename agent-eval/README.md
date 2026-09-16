# Flowmate Agent 评测目录说明

`agent-eval/` 是 Flowmate 的独立质量工程目录，保存评测方案、质量数据、评测设施和设施自检。它用于准备与审核数据、装配测试条件、核验运行证据、评分和比较版本效果。

本 README 解释每个文件夹的职责、用途、相互关系和建设状态。数据文件的完整字段与参数见 [数据使用手册](D:/code/Flowmate/agent-eval/data/README.md)，来源整理和制作流程见 [数据制作方案](D:/code/Flowmate/agent-eval/docs/data/data-preparation.md)。

## 一、从哪里开始阅读

| 需要了解的内容 | 阅读入口 |
|---|---|
| 产品需要实现什么 | [产品总方案](D:/code/Flowmate/docs/spec/00_Flowmate完整方案.md) |
| 评测什么、怎样判定、按什么阶段推进 | [Agent 评测总方案](D:/code/Flowmate/agent-eval/docs/spec/01_Flowmate_Agent评测总方案.md) |
| 每个评测文件夹做什么 | 本 README |
| 数据如何选择、制作和审核 | [数据制作方案](D:/code/Flowmate/agent-eval/docs/data/data-preparation.md) |
| 数据字段、场景参数、审核命令如何使用 | [数据使用手册与参数字典](D:/code/Flowmate/agent-eval/data/README.md) |
| 当前物化、证据加载和评分接口 | [离线评测设施说明](D:/code/Flowmate/agent-eval/src/README.md) |

## 二、当前状态与目录结构

当前已有 `docs/`、`data/`、`src/`、`tests/`、`tools/` 五类目录。已实现部分离线输入物化、可信证据加载接口、评分和设施自检；尚无完整产品/SDK 执行器，也没有实际 Agent 成绩。

本次范围同步已完成，当前为 1,200 份 Gold 候选、600 套模拟业务资料及 5,577 个用例实例：从旧 6,000 例退役 9 个场景族的 423 例，不补数。实际发布状态以 `data/manifests/preparation-report.json` 和 `scope-sync.json` 为准。用户对旧 7,801 项资产的批量审核声明已登记于 `manifests/reviews/user-confirmation-20260915T145419376406Z.json`，其中原票审核声明为 1,200 份；声明及绑定旧内容必须保留。它不是逐字段答案与证据的结构化 Gold，后者发布计数和实际产品运行数仍为 0。修改后的业务资料、用例及政策重新进入待复核状态，不能继承旧确认；未改 Gold 和来源保留原身份与内容。材料生成、内容审核、夹具物化、真实执行和评测通过分别记录。

### 2.1 已有目录

```text
agent-eval/
├─ README.md
├─ docs/
│  ├─ spec/
│  │  └─ 01_Flowmate_Agent评测总方案.md
│  └─ data/
│     ├─ data-preparation.md
│     └─ data-alignment-plan.md
├─ data/
│  ├─ README.md
│  ├─ source-labels/
│  │  └─ voxel51/
│  │     ├─ manifest.json
│  │     └─ <sourceSampleId>/
│  │        ├─ annotation.json
│  │        └─ fields.json
│  ├─ gold/
│  ├─ business/
│  ├─ cases/
│  │  ├─ extraction/
│  │  ├─ matching/
│  │  ├─ approval/
│  │  ├─ submission/
│  │  ├─ runtime/
│  │  ├─ isolation/
│  │  └─ platform/
│  ├─ manifests/
│  │  ├─ audit/
│  │  ├─ materialization/
│  │  ├─ review-forms/
│  │  ├─ reviews/
│  │  └─ <统一清单、政策、需求映射和覆盖报告>
│  └─ runs/
│     └─ README.md
├─ src/
│  ├─ README.md
│  ├─ contracts.py
│  ├─ runner/
│  │  ├─ materialize.py
│  │  └─ evidence.py
│  └─ graders/
│     └─ observations.py
├─ tests/
│  ├─ test_offline_facilities.py
│  └─ test_alignment_regressions.py
└─ tools/
   ├─ prepare_invoice_data.py
   ├─ finalize_invoice_data.py
   ├─ sync_invoice_scope.py
   ├─ invoice_case_catalog.py
   ├─ invoice_requirements.py
   ├─ audit_invoice_assets.py
   ├─ review_invoice_data.py
   ├─ verify_invoice_data.py
   └─ test_invoice_*.py
```

`<...>` 是占位说明，不是实际目录名。Python 运行时可能产生的 `__pycache__/` 是可重新生成的解释器缓存，不承担数据、源码或成绩保存职责。

### 2.2 按实际需要建立的目录

| 目录 | 建立时机 | 用途 |
|---|---|---|
| `docs/plans/` | 进入对应 P0–P13 阶段时 | 保存该阶段评测实施方案、适用范围、执行与退出要求 |
| `benchmarks/` | 某项基准协议开始具体落地时 | 集中保存可版本化的基准定义及获准引用 |
| `config/` | 执行设施需要具体配置时 | 保存非秘密运行配置、环境模板和适配器配置 |
| `data/manifests/reviews/`（已建立） | 已收到用户批量审核确认 | 当前保存用户声明及逐资产摘要；逐字段正式提交记录按需补齐 |
| `data/runs/<runId>/` | 实际执行发生时 | 保存本次运行记录、证据引用、评分和报告 |

表中尚未建立的目录按需创建，不提前铺空目录，也不以 V1、V2 等名称复制整套数据根。

## 三、docs：评测方案与实施约定

### `docs/`

保存评测工程的设计和实施文档。它回答评测对象、覆盖范围、执行条件、评分口径、阶段目标和质量放行依据等问题，供开发、评测和审核人员共同使用。

此目录保存规范与实施说明；用例实例、业务资料、答案及实际成绩分别进入 `data/` 的对应位置。修改规范后，需要检查用例映射和覆盖报告是否仍然适用，不能仅凭文档已更新就认为数据已对齐。

### `docs/spec/`

保存全项目评测总方案。当前文件 `01_Flowmate_Agent评测总方案.md` 定义模块覆盖、Case/Gold/Oracle、Benchmark、评分、归因和 P0–P13 路线。

产品总方案决定被测行为，评测总方案决定如何取得证据并判断该行为。两者通过明确的要求与检查项关联；数据中的 `requirements.json` 和 `coverage.json` 用于记录这些映射及尚未覆盖的部分。

### `docs/data/`

集中保存评测数据的制作与对齐文档，与实际质量资产目录 `agent-eval/data/` 分工：这里说明制作和修订方法，后者保存数据、审核记录与运行结果。

| 文件 | 作用 |
|---|---|
| [data-preparation.md](D:/code/Flowmate/agent-eval/docs/data/data-preparation.md) | 数据范围、选样划分、制作与审核要求、目录及检查命令 |
| [data-alignment-plan.md](D:/code/Flowmate/agent-eval/docs/data/data-alignment-plan.md) | 与主方案对齐的修订范围、退役规则、实施顺序和接收依据 |

### `docs/plans/`（按阶段建立）

把总方案落实为当前阶段可以执行的工作：本次新增能力、受影响的前序回归、Case 与基准引用、适配器和环境、证据要求、负责人及退出标准。

阶段文件按 `P0_Agent评测实施方案.md` 至 `P13_Agent评测实施方案.md` 命名。阶段方案引用固定 Case/基准身份与修订，不复制一套阶段专用数据，也不维护另一份可独立变更的基准成员和评分门槛。

## 四、data：质量资产、审核与运行记录

`data/` 保存实际评测材料及质量结果，并保持 Git 忽略。业务 Agent 的资源发现、文件读取、Context 和工具范围必须排除整个 `agent-eval/`；可信评测控制器只向产品提供当前用例明确获准的输入。

### 4.1 来源资料与业务资料

| 文件夹 | 保存什么 | 何时、怎样使用 |
|---|---|---|
| `data/source-labels/` | 提供方标签原始记录和字段映射 | 制作候选、核查标签来源；标签不能直接当已核验正确答案 |
| `data/source-labels/voxel51/` | voxel51 的标签 manifest 及来源记录 | 通过来源 ID、去重原票 ID 和摘要查找对应原票 |
| `data/source-labels/voxel51/<sourceSampleId>/` | annotation.json、fields.json | 保留去重前来源标签身份；同原图的不同来源标签不静默覆盖 |
| `data/gold/` | 每份原票的字段、明细、证据候选及实际审核后的答案 | 人工逐票核验；可信评分器只使用满足核验要求的固定答案 |
| `data/business/` | 模拟结构化发票、供应商、订单、收货、审批和目标系统初态 | 构造业务匹配、审批及提交测试；仅将获准 input 部分投影给产品 |

原始发票及配对解析保存在项目 `data/invoices/voxel51/`，由质量数据引用，不复制进本目录。模拟业务资料的金额和状态属于合成输入，不能作为原图抽取答案；原票理解链和模拟业务链分别评分。

### 4.2 cases：按能力保存用例

Case 是固定输入、初态、触发、允许与禁止行为、证据要求和判据的组合。`cases/` 保存定义，不保存实际执行结果。全文包含评分信息，不能整个交给业务 Agent。

| 文件夹 | 同步后实例数 | 被测能力与用途 |
|---|---:|---|
| `data/cases/extraction/` | 1,200 | 票头、买卖方、金额、明细及证据定位；每票一个完整抽取例 |
| `data/cases/matching/` | 890 | 按需匹配供应商、订单与收货；检查合同价格、数量、订单余额、金额及重复记录 |
| `data/cases/approval/` | 487 | 人工修订、澄清、具体 B2B 提交确认、拒绝、撤销、过期、内容变化失效及接管 |
| `data/cases/submission/` | 800 | B2B 提交、权威回读、UNKNOWN 核对、幂等及故障恢复 |
| `data/cases/runtime/` | 1,000 | Provider、工具、Session、上下文、压缩、取消、扩展、子 Agent 和 Host 机制 |
| `data/cases/isolation/` | 800 | 获准读取、越界访问、不可信输入、权限撤销及独立合法对照 |
| `data/cases/platform/` | 400 | 数据接入、完整性、工作区、控制者竞争、备份迁移和评测设施正确性 |

当前共 177 个场景族：extraction 1、matching 16、approval 13、submission 16、runtime 63、isolation 39、platform 29。匹配按业务需要触发；不要求产品内 OCR/Parser 执行、外部验真、ERP 回写、自动拆合票、额度/多级财务审批、强制两人分离、通用员工创建/复杂配置 UI 或第二任务证明。外部解析导入、原件证据、ERP 只读资料、原生 Runtime/Memory/Extension/Subagent 和平台基础验证保留。

开发、回归、验收属于用途划分，P0–P13 和 BM 属于阶段或基准引用；这些维度通过清单关联同一资产，不再复制文件。多个实例引用同票或同场景时，不能按实例数宣称同样数量的独立业务样本。

### 4.3 manifests：统一索引与质量管理

`data/manifests/` 将分散的资产组织成可检查、可追溯的数据集。它保存身份、路径、摘要、用途、政策、需求映射、审核任务及当前准备状态。

| 文件夹或文件 | 作用与使用方式 |
|---|---|
| `inventory.json` | 统一记录受管理文件的路径、大小和摘要；用于发现未授权改动、缺失或新增文件 |
| `preparation-report.json` | 查看材料数量、检查结果及未完成事项；不是 Agent 成绩 |
| `splits.json` | 查询开发、回归、验收和储备成员及原票关联组 |
| `case-catalog.json` | 查询场景族、Case 身份、位置和分类 |
| `fixture-policy.json` | 固定模拟金额、匹配、审批及异常处理规则；不代表真实企业政策 |
| `requirements.json` | 保存主方案要求及来源引用 |
| `coverage.json` | 记录检查级映射和缺口；部分材料准备不等于要求已经通过 |
| `review-queue.csv` | 1,200 份原票核验入口，关联候选与原图 |
| `views.json` | 用清单表达阶段、Benchmark、黄金集、错题集等视图 |
| `review-forms/` | 保存待填写的逐票字段草表；正式审核按工具要求导出完整外层表单后提交 |
| `audit/` | 保存机器特征、近重复候选、累计核验批次及综合任务单 |
| `materialization/` | 保存离线构造的输入、可信控制配置及每例支持状态 |
| `reviews/` | 已保存用户批量审核确认与逐资产摘要；后续逐字段提交记录保留父内容、依据及审核者声明 |
| `history/*.zip` / `scope-sync.json` | 保留范围同步前审核绑定的旧内容，并记录退役、修订及新旧摘要；不是另一套可变当前数据 |

`audit/` 中 `sample-features.json` 提供采样与相似性线索；`near-duplicate-pairs.jsonl` 和 `near-duplicate-groups.json` 供人工判断是否同票；`batches.json` 用于累计分批接收；综合 `review-queue.csv` 同时管理 Gold、业务资料和 Case，区别于父目录的原票队列；`audit-report.json` 汇总机器审计情况。近重复候选不自动证明同票，也不自动冻结用途划分。

`materialization/` 中 `cases.jsonl` 记录每例物化状态与输入摘要，`fixtures.jsonl` 保存已支持用例的 input 和 harness，`report.json` 汇总支持数量及限制。input 是可投影部分；harness 是可信控制器持有的时钟、身份、故障和测试环境配置。夹具已生成不代表产品已经运行。

### 4.4 runs：真实运行的证据和结果

`data/runs/` 当前只有 README，尚无真实运行目录。后续 `runs/<runId>/` 用独立运行身份关联固定 Case、判据、配置和适配器，保存实际观测、证据引用、评分与报告。

一次 Case 执行多次应形成多次运行记录，不新增同义 Case 来增加覆盖。评分器自检产生的模拟结果不能伪装成产品成绩；产品业务事实仍保存在产品运行数据根，评测通过受控引用关联证据，不回写来源发票或另建一套业务事实。

## 五、src：可复用评测设施

`src/` 保存持续使用的评测实现。它承担输入装配、证据读取和评分等职责，数据准备之后仍然需要；当前实现是离线设施的一部分，完整产品/SDK 执行链要随阶段继续接入。

### `src/runner/`

负责把固定用例连接到具体测试条件和可信观测。当前包含：

| 文件 | 输入与职责 | 输出及限制 |
|---|---|---|
| `materialize.py` | 读取 Case 条件及必要业务包，计算一致的模拟输入，构造身份、时钟、历史、文件和故障配置 | 返回 input、harness 和支持限制；不支持的机制保持依赖未齐，不手写原生 SDK 成功历史 |
| `evidence.py` | 从受控运行根读取真实文件，校验摘要、Case/版本、Run 和适配器来源 | 通过可信适配器回调后返回受完整性保护的观测；普通 JSON 自称 product_run 不足以获信 |

后续运行设施复用产品公开入口及根测试设施，负责装配、触发和采证；不能另写一套产品业务逻辑或模型—工具循环来代替被测实现。

### `src/graders/`

负责按功能复用评分实现。当前 `observations.py` 的 `grade(case, observation, gold=None)` 比较必要检查、字段和证据，区分通过、失败、证据不足及设施错误。

安全用例分别判断模型行为、平台控制与实际后果，并要求独立合法对照。抽取评分依赖实际核验后的 Gold。缺失必要规则或证据不能默认通过；当前评分输出仍不自动赋予正式阶段验收资格。

Grader 按能力复用，同一实现可以被多个 Benchmark 引用，不按 BM 复制评分代码。

### `src/contracts.py` 与 `src/README.md`

`contracts.py` 保存当前评测内部的用例检查契约和逐项结果聚合逻辑，供评分器及自检复用；它不是产品公共 contracts 包。`src/README.md` 说明现有物化、可信证据入口及判定接口，供维护设施和接入适配器时阅读。

## 六、tests：验证评测设施本身

`tests/` 验证质量工具是否正确解释输入、保持边界、识别缺证据和汇总结果。当前文件职责如下：

| 文件 | 主要检查范围 |
|---|---|
| `test_offline_facilities.py` | 业务夹具算术与关联、故障构造、不支持场景处理、比较运算、证据要求、抽取 Gold 和合法对照 |
| `test_alignment_regressions.py` | 防止已修复的评分和证据问题回归，包括必要项失败被掩盖、伪造产品声明、证据篡改、错误对照及攻击未到达模型 |

这里的测试通过表示相应评测设施自检通过，不能记成业务 Agent 成绩。产品功能与机制测试按主方案放在项目根 `tests/` 或所属产品模块；评测消费同版本、同配置、同场景的有效证据，避免重复实现产品测试逻辑。

### `tools/`：数据制作、审核和检查工具

工具集中在 `agent-eval/tools/`，项目根不再保留另一份 tools 目录。它与 src、tests、data 同属评测工程；命令中的 `--project .` 仍指项目根 `D:/code/Flowmate`，不随脚本移动而改变。

| 文件 | 作用与使用时机 |
|---|---|
| `prepare_invoice_data.py` | 首次盘点、去重、导入和候选生成；也提供审核与审计仍在使用的文件及摘要公共函数 |
| `finalize_invoice_data.py` | 首次合并历史机器草案；不能覆盖已有人工审核或运行历史 |
| `sync_invoice_scope.py` | 核验旧清单，在暂存根同步已批准范围，保存旧内容归档及迁移记录，检查后发布唯一当前数据 |
| `invoice_case_catalog.py` | 场景族及条件定义，供制作、物化和自检复用 |
| `invoice_requirements.py` | 从主方案提取要求、关联用例检查并生成或验证覆盖信息 |
| `audit_invoice_assets.py` | 提取机器特征、发现近重复线索、组织累计审核批次；校验器复用其批次规则 |
| `review_invoice_data.py` | 导出和接收实际人工审核、保存历史与当前资产、维护统一摘要清单 |
| `verify_invoice_data.py` | 检查来源文件、质量资产、引用、摘要、用途及覆盖一致性 |
| `test_invoice_*.py` | 数据制作、整合、审核、审计和需求映射工具的自检 |

`tools/test_invoice_*.py` 检查数据维护工具，`tests/` 检查物化、证据和评分设施；两者均不代表真实 Agent 成绩。工具自检从项目根运行：

```powershell
python -m unittest discover -s agent-eval/tools -p "test_invoice_*.py" -v
```

## 七、benchmarks 与 config 的后续职责

### `benchmarks/`（按需建立）

集中保存标准化基准协议：任务引用、成员或采样规则、运行环境、预算、评分口径及比较条件。BM-01–BM-12 当前是自有基准覆盖目录，不表示每项已建立可执行基准。

基准定义按 BM 身份组织，引用功能目录中的 Case、Gold/Oracle、评分器和环境模板。敏感成员、答案、业务原文、账号与实际成绩留在受控数据位置；非敏感定义进入版本管理。成员关系本身敏感时，定义只保存获准的版本和摘要引用。

Benchmark 是标准化测量协议；Baseline 是按固定协议实际执行得到的参考成绩。BM-10 日常监控和抽检不自动形成可比较基准，公共基准也仅作适用补充。变更任务、规则或预算后，应重新核对结果是否可比。

### `config/`（按需建立）

保存非秘密的运行参数、环境模板和适配器设置，供执行设施解析。真实凭证不放入此目录，具体注入方式由阶段方案确定。

配置不能维护另一套可覆盖冻结基准的成员清单或评分门槛。执行时固定实际解析后的配置和依赖，并将其关联到运行记录，不能仅引用随时变化的“最新配置”。

## 八、与项目其他目录的关系

| 项目位置 | 与 agent-eval 的关系 |
|---|---|
| `docs/spec/00_Flowmate完整方案.md` | 定义产品行为及建设阶段，是评测要求的来源 |
| `agent-eval/docs/data/data-preparation.md` | 说明选样、制作、审核和交接方法 |
| `data/invoices/voxel51/` | 提供唯一原票、解析和来源摘要，质量侧按稳定引用访问 |
| `agent-eval/tools/` | 提供来源整理、场景定义、需求映射、机器审计、人工审核及完整性检查；部分公共函数仍被评测设施使用 |
| 产品源码与项目根 `tests/` | 提供被测能力和产品机制证据；产品代码不得反向依赖 agent-eval 实现 |
| 产品运行数据根 | 保存真实业务状态和产品产物；与质量数据根分离，评测只按权限关联证据 |

因此 `tools/`、`src/` 和 `data/` 分别承担工具、设施和资产职责，不能因为数据已经生成就整体删除前两者。若要精简一次性制作脚本，应先检查仍被审核、校验和物化代码引用的函数。

## 九、日常使用顺序与维护规则

1. 阅读总方案和当前阶段要求，确认被测能力及可用入口。
2. 查看 preparation-report、coverage、splits 和审核队列，确认材料、用途和依赖。
3. 对原票、模拟业务资料、政策和用例完成真实内容审核，按规定保留记录。
4. 固定本次 Case、输入、判据、环境与预算，只向产品投影获准输入。
5. 运行适用设施自检，再通过实际产品入口执行并采集可信证据。
6. 按功能评分并分别报告通过、失败、缺证据和设施错误，保存本次配置与运行身份。
7. 通过清单维护回归、黄金、错题和挑战视图，保留历史结果及原固定版本依据。

从项目根 `D:/code/Flowmate` 执行现有检查：

```powershell
# 来源与质量数据完整性检查
python agent-eval/tools/verify_invoice_data.py --project .

# 查看当前人工审核状态
python agent-eval/tools/review_invoice_data.py --project . inspect

# 评测设施自检，结果不能当作 Agent 成绩
python -m unittest discover -s agent-eval/tests -v
```

这三条命令不完成原票人工核验，也不运行真实业务 Agent。物化输出有新目录和覆盖保护要求，具体接口见 src/README；不要为重跑检查而覆盖现有物化材料。

### 持续维护约束

- 数据采用一套当前目录，身份、修订和摘要保留追溯；原票、Case、Gold 不按阶段或 BM 复制。
- `data/` 保持 Git 忽略；代码、设施测试和非敏感规范按项目版本管理。
- 新增或调整文件夹时同步更新本 README；调整数据格式时同步更新 data/README 及相关校验。
- 修改受 inventory 管理的质量文件，必须先校验旧清单，再按明确的变更范围更新摘要；根 README 位于质量数据根之外。
- 不把待核验材料、离线物化或设施自检登记为实际评测通过，不用一个总通过率代替各能力结果。
- 主子 Session 均不能遍历质量目录；可信控制器的输入投影不扩大产品读取权限，质量结论不授予生产写权限。

## 十、与阶段主方案保持一致

评测沿用产品主方案第 21 章 P0–P13 建设轴：P0 验证基础契约与存储，P1 开始真实 Agent 接入，P12 验证完整桌面与模拟/真实测试业务链，P13 建立 Host 及 Test → Shadow → Canary → Production 质量放行。每阶段评测本次新增能力并回归受影响的前序能力，历史阶段标签和成绩不能直接作为新阶段验收依据。

工作空间和资源生命周期按评测总方案第 3.23 节核验，包括默认空间身份、策略交集、暂停/归档、同空间绑定，以及产品 runtime 下 work、agent 与 sessions 历史的分离。首版单默认空间不代表多租户隔离已实现。模型重试从 P3 起按需评测，P10 原生扩展与 P11 子 Agent 插件分别启用；启动屏障、公共组装、StepAttempt、桌面故障/IPC和生产日志等要求按总方案相应条目落实。这些都是适用要求，完成情况须由实际证据证明。
