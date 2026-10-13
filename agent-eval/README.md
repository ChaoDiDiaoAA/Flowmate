# Flowmate Agent 评测

评测数据及保存产物无哈希，公开版本固定为 v1。第一阶段只做工程、数据和模拟验证，真实评测、校准及平台上传留待后续执行。

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

数据校验无需凭据。doctor 检查配置、数据和本机运行环境，必要时只读模型元数据，不生成回答或评分；未就绪返回非零状态。三个 TS 数据文件、场景和 Fixture 的详细制作约定见 docs/eval。本地Agent评测由CLI启动独立本机Host，不需要Docker或镜像。

## 执行评测

工程 E2E 使用测试环境和模拟模型，不读取真实评测凭据：

```bash
bun run test:e2e
```

以下命令会调用真实 Agent 和 Judge，有实际模型费用；本轮没有执行：

```bash
bun run eval:smoke
bun run eval:full
```

Smoke 共14题（业务10＋研究4），Full 共62题（业务50＋研究12）。按业务→研究顺序执行，每题默认一次，两组各保存一个 Execution／报告，并输出对应 ID 和路径。普通失败继续执行；取消或停止未确认则阻断后续 Trial 和下一组。退出码0表示必要自动评分通过，1表示失败／错误／执行不完整，2表示必要评分待判，人工验收独立。

终端默认显示全局题目序号、Case ID、环境准备／Agent执行／停止清理／评分／保存阶段。阶段开始以 `▶` 标记，等待时每60秒以 `⏳` 提示当前阶段及已等待时间（60秒、120秒等）；切换阶段后重新计时，结束后停止提示。60秒仅控制日志频率，不改变任务超时。

Agent结束后显示 `✅ Agent执行成功` 或 `❌ Agent执行失败`，超时、取消、未启动分别以 `⚠`、`⏹`、`⏭` 标明。评分结束后显示 `✅ 通过（PASS）`、`❌ 失败（FAIL）`、`❌ 错误（ERROR）`、`⚠ 未判定（UNJUDGEABLE）` 或 `⏭ 未运行（NOT_RUN）`，并保留原因；业务 FAIL 同时有 Judge ERROR 时追加简短评分异常。每题保存成功后以 `💾` 显示状态、耗时和 `evidence/<trial-id>/`，业务组结束立即显示报告路径。进度写入 stderr；run／Smoke／Full结束不自动打印整段JSON，完整结果保存到report.json，显式status可查看。

## 查看或上传结果

```bash
bun run eval -- status --execution-id <ID>
bun run eval:upload -- --execution-id <ID>
```

Smoke／Full 始终本地执行，填写 Langfuse 配置不会触发上传。两组结果按各自 ID 单独上传；重复上传命令只补传已有结果，不重跑 Agent 或 Judge。兼容维护入口 resend --report <绝对路径>，与 --execution-id 二选一。

结果保存在 agent-eval/runs/<execution-id>/：snapshot.json、report.json、evidence/<trial-id>/{trial.json,observation.json,events.jsonl}。artifacts/、review.json 和 export.json 仅在有实际产物、反馈或导出时保存。旧报告保持可读，比较实际声明和参数，不仅比较 v1。

`evidence/` 下每个 Trial 都有独立子目录，多个 Case 和重复尝试不会平铺或共用证据文件。取消、停止不明或运行异常时，终端显示原因及已有报告位置；仍在等待、单题已保存或已有目录均不表示整批评测通过。用 `status` 核对执行与评分状态；`pending` 表示尚未完成评分。

Judge通过Pi SDK provider生成评分。Judge 复用现有 Pi SDK ModelRuntime.completeSimple、模型目录和原生能力解析；模型、凭据与主 Agent 独立，不装配业务工具。FLOWMATE_JUDGE_API 显式优先，未设置时兼容旧 PROVIDER 的 anthropic／openai-compatible 映射，均未设置时默认 openai-completions。默认及本次采用的超时为180000毫秒，可显式覆盖；取消有效，SDK 自动生成重试关闭，每 Trial 最多一次生成。
