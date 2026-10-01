# Flowmate

## 项目与当前阶段

基于 Pi SDK 的本地发票 Agent。当前工作区已实现受控解析材料导入、发票工作台、Assistant 对话及重启续聊、P4 原生消息查询/展示和候选来源记录。普通复核工厂保留13项业务工具，可信桌面另装配第14项填表工具；本轮人工保存、接受和三格式导出接合及工程证据见 [P4实施计划 §5](docs/plans/P4_实施计划_v1.md)。原票供人工查看，业务取证使用已登记解析材料。旧连接的真实模型 A20 请求、失败/复验和样例观察保留在 [P3 实施计划](docs/plans/P3_实施计划_v1.md)；新配置的连接/认证/协议工程记录按其实际范围解释。真实模型自主填表及业务正确性统一归 [评测总方案 §12](docs/eval/01_Flowmate_Agent评测总方案_v1.md#12-统一评测启用与验收)：P16及整体产品、真实 Agent 入口与必要采证就绪且工程验证通过后才制作和运行 Benchmark，不作为当前阶段剩余任务。

## 安装与配置

```powershell
bun install --frozen-lockfile
```

模型只在桌面 **Models** 页面配置。选择 Pi 内置供应商和模型后，在页面填写并保存 API Key；现行桌面不使用环境变量或旧 OAuth 凭据代替该 Key。明确选择 **Custom model** 才填写 Base URL、Pi API 类型和实际模型能力。凭据保存在系统加密存储中。评测用的 Judge、Langfuse 可单独配置 [.env.example](.env.example)。

## 启动与使用

在仓库根目录执行：

```powershell
bun run dev                       # 启动桌面应用
bun --no-env-file run test        # 工程验证，不运行 Agent 评测
```

桌面启动、打开页面和保存配置不会自动请求模型。用户点击 **Test connection**、Assistant 的 **Send** 或 **Fill with Agent** 才会请求模型，可能产生费用。新会话的 Pi 原生历史保存到 SQLite，可在重启后续聊；升级前没有原生历史的旧会话只读。桌面正式数据位于 `%APPDATA%\Flowmate`，工程测试使用隔离临时目录。

开发时 Renderer 支持热更新；修改 Main/Preload 会先停止当前请求、关闭旧 Host 和 Electron，再构建和启动新实例。构建失败会等待修正，停止未确认会阻止重启。结束开发请按 Ctrl+C，等待关闭完成。

正式发票导入来源为仓库 `data/invoices/agent-input/`。在 **Invoices** 导入并查看 **Original / Parsed / Results**，点击 **Process this invoice** 建立待发送任务，再到右侧 **Assistant** 点击 **Send**。Agent 只读取已登记的解析数据和来源，不发送原票图像，也不运行解析器。**Processing History** 展示候选、来源、问题和操作历史；其 **Delete** 仅从近期列表隐藏处理记录，保留候选与审计。**Chats** 和左侧最近会话均可重命名。撤回材料使用权限后，受影响的会话不能继续请求模型。

候选结果存放在 `%APPDATA%\Flowmate\data\app.sqlite` 的 `invoice_candidates` 表中，字段、明细、问题及来源引用随候选保存；`tool_calls` 和 `business_events` 保留调用与操作记录。生成候选不等于用户接受，接受状态需另行选择。

在 **Invoices → Results** 明确选择未接受候选后，可点击 **Fill with Agent** 通过独立录入 Run 填入固定表单，或点击 **Edit** 直接人工编辑。**Save changes** 有真实差异才追加人工版本；**Accept result** 独立接受已保存版本，随后可导出 JSON、CSV、Markdown。打开、选择、人工保存和接受均不请求模型。未保存副本只存在于当前窗口，离开/正常关闭提供 Save、Discard、Continue editing；未知提交先查询原操作，不自动再填或再保存，重启只恢复已保存候选。

**Chats → Run tools** 可用 **Choose directory** 设置下一次发送的工作目录，或用 **Use Run directory** 恢复默认的 `%APPDATA%\Flowmate\runtime\<runId>\work`。**Refresh tools** 查看当前平台支持的 Pi 原生工具；选择和刷新不执行，仍用普通 Assistant **Send** 发起、**Stop** 停止。目录不是沙箱，平台支持也不保证 Shell／搜索依赖已经可执行，实际缺失由 SDK 返回。

**Models** 和 **Settings → Diagnostics** 显示 Runtime 是否可继续，**Check runtime status** 只查询状态。取消受理、回答结束或数据库终态都不单独证明可以发送下一条；实际执行仍占用、必要保存失败或停止证据不足时，Send／Test connection 保持禁用。重启会核验原 Run／工具，不会重放或把未知停止改为成功；缺证据时仍只读受阻，具体实现与工程证据见 [P1 实施计划 §11.8](docs/plans/P1_实施计划_v1.md#p1-state-increment)。

## 文档导航

[产品方案](docs/spec/00_Flowmate完整方案_v1.md) · [P3 目标](docs/spec/P3_目标方案_v1.md) · [P3 实施计划](docs/plans/P3_实施计划_v1.md) · [P1 目标](docs/spec/P1_目标方案_v1.md) · [P1 实施计划](docs/plans/P1_实施计划_v1.md)

[评测总方案](docs/eval/01_Flowmate_Agent评测总方案_v1.md) · [Case 制作手册](docs/eval/02_Flowmate_Agent评测数据集制作方案_v1.md) · [可选 Langfuse](docs/eval/03_Flowmate_Langfuse平台接入设计方案_v1.md)

[工程测试](tests/README.md) · [评测操作](agent-eval/README.md) · [设施测试](agent-eval/tests/README.md) · [源码职责](agent-eval/src/README.md) · [Judge 配置](agent-eval/src/scoring/judges/README.md)
