# Flowmate

## 项目与当前阶段

基于 Pi SDK 的本地发票 Agent。当前工作区已实现 P3 的受控解析材料导入、英文发票工作台、Assistant 对话及重启续聊、13 个按可信现场暴露的工具、候选与来源记录。原票仅供工作台人工查看，Agent 使用已登记的解析文本和表格。旧连接的真实模型 A20 结果保留在 [P3 实施计划](docs/plans/P3_实施计划_v1.md)；新配置需要单独验证。统一业务 Benchmark 仍待制作。

## 安装与配置

```powershell
bun install --frozen-lockfile
```

模型只在桌面 **Models** 页面配置。选择 Pi 内置供应商和模型后，按该供应商支持的方式设置 API Key、登录，或使用 Pi 的环境认证；明确选择 **Custom model** 才填写 Base URL、Pi API 类型和模型能力。凭据保存在系统加密存储中。评测用的 Judge、Langfuse 可单独配置 [.env.example](.env.example)。

## 启动与使用

在仓库根目录执行：

```powershell
bun run dev                       # 启动桌面应用
bun --no-env-file run test        # 工程验证，不运行 Agent 评测
```

桌面启动、打开页面和保存配置不会自动请求模型。用户点击 **Test connection** 或 Assistant 的 **Send** 才会请求模型，可能产生费用。新会话的 Pi 原生历史保存到 SQLite，可在重启后续聊；升级前没有原生历史的旧会话只读。桌面正式数据位于 `%APPDATA%\Flowmate`，工程测试使用隔离临时目录。

正式发票导入来源为仓库 `data/invoices/agent-input/`。在 **Invoices** 导入并查看 **Original / Parsed / Results**，点击 **Process this invoice** 建立待发送任务，再到右侧 **Assistant** 点击 **Send**。Agent 只读取已登记的解析数据和来源，不发送原票图像，也不运行解析器。**Processing History** 展示候选、来源、问题和操作历史；其 **Delete** 仅从近期列表隐藏处理记录，保留候选与审计。**Chats** 和左侧最近会话均可重命名。撤回材料使用权限后，受影响的会话不能继续请求模型。

候选结果存放在 `%APPDATA%\Flowmate\data\app.sqlite` 的 `invoice_candidates` 表中，字段、明细、问题及来源引用随候选保存；`tool_calls` 和 `business_events` 保留调用与操作记录。生成候选不等于用户接受，接受状态需另行选择。

## 文档导航

[产品方案](docs/spec/00_Flowmate完整方案_v1.md) · [P3 目标](docs/spec/P3_目标方案_v1.md) · [P3 实施计划](docs/plans/P3_实施计划_v1.md) · [P1 目标](docs/spec/P1_目标方案_v1.md) · [P1 实施计划](docs/plans/P1_实施计划_v1.md)

[评测总方案](docs/eval/01_Flowmate_Agent评测总方案_v1.md) · [Case 制作手册](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) · [可选 Langfuse](docs/eval/03_Flowmate_Langfuse平台接入设计方案_v1.md)

[工程测试](tests/README.md) · [评测操作](agent-eval/README.md) · [设施测试](agent-eval/tests/README.md) · [源码职责](agent-eval/src/README.md) · [Judge 配置](agent-eval/src/scoring/judges/README.md)
