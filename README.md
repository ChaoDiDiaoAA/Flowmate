# Flowmate

## 项目与当前阶段

基于 Pi SDK 的本地发票 Agent。当前工作区已交付 P1 Provider 与 P2 Agent Session，并实现 P3 的受控材料导入、Workspace、Start Task、13 个工具、候选与来源/Activity 查看。P3 工程验收见 [P3 实施计划](docs/plans/P3_实施计划_v1.md)；代码仍在当前工作区，未提交。真实模型行为核验 A20 尚未运行，统一业务 Benchmark 仍未制作。Langfuse 是评测结果的可选展示平台。

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
bun --no-env-file run test        # 工程验证，不运行 Agent 评测
```

桌面启动、打开页面和保存配置不会自动调用模型。只有用户点击 **Test Connection**、聊天 **Send to model** 或在 CLI 输入并发送问题时，才会发起 Provider 请求，可能产生费用。桌面聊天的 Send 创建一个 Session Agent Run；同一进程中 Pi 使用该 Session 的内存历史，重启后历史不能恢复。Provider Connection 检查仍单独保存为 Provider Run。桌面正式数据位于 `%APPDATA%\Flowmate`；工程测试使用隔离临时目录。

第一次使用桌面端：打开 **Model** 配置 Base URL、Model ID、API protocol 和 API Key。随后在 **Workspace** 选择正式已有解析的材料并导入，检查原票与解析，点 **Start Task** 建立任务；回到聊天现场确认材料、任务和目标，再显式点 **Send to model**。Agent 可按获准范围读取解析、回看证据并生成本地候选。到 **Tasks** 查看候选、来源和 Activity；需要时由用户显式选择当前候选。P3 不运行 OCR/Parser，不提供候选接受或导出；撤回某材料的模型使用权限会禁用已经使用该材料的 Session，需新建 Session 才能继续。只有点击 Send 才会发起 Provider 请求，可能产生费用。桌面正式数据位于 `%APPDATA%\Flowmate`；工程测试使用隔离临时目录。

## 文档导航

[产品方案](docs/spec/00_Flowmate完整方案_v1.md) · [P3 目标](docs/spec/P3_目标方案_v1.md) · [P3 实施计划](docs/plans/P3_实施计划_v1.md) · [P1 目标](docs/spec/P1_目标方案_v1.md) · [P1 实施计划](docs/plans/P1_实施计划_v1.md)

[评测总方案](docs/eval/01_Flowmate_Agent评测总方案_v1.md) · [Case 制作手册](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) · [可选 Langfuse](docs/eval/03_Flowmate_Langfuse平台接入设计方案_v1.md)

[工程测试](tests/README.md) · [评测操作](agent-eval/README.md) · [设施测试](agent-eval/tests/README.md) · [源码职责](agent-eval/src/README.md) · [Judge 配置](agent-eval/src/scoring/judges/README.md)
