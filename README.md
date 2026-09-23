# Flowmate

## 项目与当前阶段

基于 Pi SDK 的本地发票 Agent，目标是整理材料、生成候选、人工接受和导出。当前 P1 提供 Provider、SQLite、CLI 交互，以及三栏桌面工作台：Model/Profile、右侧单轮 Provider 聊天和 Run 诊断。每条聊天消息独立调用，不发送先前轮次；Session、多轮上下文、工具与完整 Agent 尚未交付，统一 Benchmark 尚未制作。Langfuse 是评测结果的可选展示平台。

## 安装与配置

```powershell
bun install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

[.env.example](.env.example)：`.env` 中的 `FLOWMATE_LLM_*` 用于 CLI；桌面端在 Model 页面配置连接与 API Key，密钥由系统安全存储保护。独立 Judge 和 Langfuse 只在后续评测流程中使用。工程测试使用受控本地端点，不调用付费模型或平台。

## 启动与使用

在仓库根目录执行：

```powershell
bun run dev                       # 启动三栏桌面应用
bun run cli -- provider chat      # 命令行交互聊天
bun run test                      # 工程验证，不运行 Agent 评测
```

桌面启动、打开页面和保存配置不会自动调用模型。只有用户点击 **Test Connection**、在右侧聊天框发送消息，或在 CLI 输入并发送问题时，才会发起 Provider 请求，可能产生费用。桌面聊天里每条消息都会建立并保存一个独立 Provider Run；历史轮次只在当前界面临时显示，不发送给模型。桌面正式数据位于 `%APPDATA%\Flowmate`；工程测试使用隔离临时目录。

第一次使用桌面端：打开左侧 **Model**，填写 Base URL、Model ID、API protocol 和 API Key，点 **Save changes**；再到右侧 **Agent Chat** 输入消息并点 **Send to model**。每条消息独立请求模型，回复下方的 **OPEN RUN** 可查看本次已保存输入、输出、模型、用量及错误事实。P1 不提供 Output token budget；New Session 和连续多轮上下文在 P2。

## 文档导航

[产品方案](docs/spec/00_Flowmate完整方案_v1.md) · [P1 目标](docs/spec/P1_目标方案_v1.md) · [实施计划](docs/plans/P1_实施计划_v1.md)

[评测总方案](docs/eval/01_Flowmate_Agent评测总方案_v1.md) · [Case 制作手册](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) · [可选 Langfuse](docs/eval/03_Flowmate_Langfuse平台接入设计方案_v1.md)

[工程测试](tests/README.md) · [评测操作](agent-eval/README.md) · [设施测试](agent-eval/tests/README.md) · [源码职责](agent-eval/src/README.md) · [Judge 配置](agent-eval/src/scoring/judges/README.md)
