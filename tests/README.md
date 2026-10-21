# 工程测试

模块优先，后缀分层；不依赖业务 Benchmark，不读取正式用户数据、不调用付费模型或 Langfuse。

| 目录 | 内容 |
|---|---|
| contracts/ | 输入、错误与状态契约 |
| shared/ | Windows 路径与创建边界、控制锁、系统凭据适配、日志 |
| core/configuration/ | 配置解析 |
| core/storage/ | SQLite、终态、真实 Bun 子进程崩溃后重开、损坏、单写者 |
| core/runtime/ | 生命周期、输出限制、取消竞争、迟到与实际停止 |
| core/sessions/ | 空闲Fill输入受理去重、冻结、真实user消费、处理与重启零重投 |
| core/application/ | 应用门面与真实组装 |
| runtime-pi/ | SDK 接合、受控 Provider 的协议和故障场景 |
| desktop/ | 白名单与消息投影、真实 Electron/Preload/Main/Bun Host、开发重建和退出、隔离 SQLite E2E |
| data/、employee-invoice/、logging/ | 后续阶段的材料登记、发票规则与安全 Prompt Trace 回归 |
| support/ | 受控请求、临时资源与失败清理 |

使用 `.unit.test.ts`、`.integration.test.ts`、`.e2e.test.ts`。Unit 是局部行为；Integration 是真实组件接合，外部服务使用替身。Provider CLI 及专属测试已在 P3 退役，当前交互使用桌面。Desktop E2E 经 Electron、Preload、Main、Bun Host、公共 Application、Pi 和本地合成 HTTP Provider，使用独立临时 userData/SQLite，验证配置、显式 Provider 诊断、现行 Session 对话及持久查询。窗口关闭、Quit、Main 退出与 Host 崩溃分别核验；进程被杀只证明中断恢复，不能证明正确停止。所有工程测试都不请求真实 Provider，也不运行 Agent 评测。

Electron E2E 使用 Playwright 默认 `electron.launch({ args, env })`，让已安装 SDK 完成 Inspector/ready 同步，不指定二进制路径而跳过其 loader。正常退出安排在当前 evaluation 返回后，仍须确认真实子进程退出；没有退出确认不能删除未关闭的夹具或认作 Host 已停止。开发入口继续使用自身真实 Node/IPC，不复制 Playwright 私有 loader。

```powershell
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:e2e
bun run test
```

`test` 按类型→单元→集成→桌面构建→E2E 顺序运行，失败返回非零。类型检查包含评测设施测试。[scripts/test.ts](../scripts/test.ts) 按后缀发现：Unit／Integration调用 Bun `test --isolate`，E2E调用已安装的 Node 24 和 `@playwright/test` CLI（一个worker）。零文件和未分类测试报错，不排除存储、生命周期或组装。Node E2E沿用原受控HTTP／流式Response及SQLite断言，使用原生node:http／node:sqlite；各文件显式注册共享资源清理。

[dev.e2e.test.ts](desktop/dev.e2e.test.ts) 在自有临时目录复制源码，连接已安装依赖，运行真实开发入口；检查原生 BrowserWindow.isVisible() 为 true、初始及后续构建失败不启动、Main/Preload 重建前停止原请求、原 Run 保留、无自动重放，以及退出后的端点与锁释放。DOM visible 或 Host Ready 本身不证明桌面窗口显示。Windows 的 `kill('SIGINT')` 是强制结束；该测试通过进程内事件触发已注册的 SIGINT 处理分支，实际控制台 Ctrl+C 的传播仍以本机操作为准。

[theme.e2e.test.ts](desktop/theme.e2e.test.ts) 验证 Theme 的页面内置下拉菜单：实际点击展开、选项可见与可点击、方向键选择、Escape 收起、三种主题和保存后重新加载。开发入口也检查点击选项和保存后再次展开；不以 `selectOption()` 直接赋值代替弹层交互。旧系统弹层在隔离环境可正常展开，用户报告的具体触发原因尚未复现；本次改用锁定 Electron/Chromium 支持的 `appearance: base-select`，保持同一个 select 和设置保存契约，避免该控件依赖系统弹出菜单。

[native-tools.e2e.test.ts](desktop/native-tools.e2e.test.ts) 从普通 Assistant **Send** 实际执行 SDK read/grep/find/ls/edit/write/bash/powershell，核对文件、Provider 后续 toolResult、SQLite 记录、每个 Run 的目录和重载历史零重放；再停止实际 PowerShell 在途命令并检查无迟到文件。选择目录、刷新工具和保存配置不创建 Run、不请求模型。测试使用当前安装的 SDK 搜索依赖；为本测试的隔离进程把已安装 Git Bash 目录置于 PATH，产品仍由 Pi 自行发现 Shell，测试不替换 SDK execute。

[invoice-form.e2e.test.ts](desktop/invoice-form.e2e.test.ts) 经真实公开桌面入口生成并选择候选，Fill经过SDK/Executor/SQLite/Main/Renderer实际控件及匹配回执，再核后续HTTP安全toolResult；人工Save/Accept/三格式导出沿真实用户命令核新版本/来源及文件。私有inspect仅验证当前副本，不作为模型消息或工具。配套 `invoice-form.unit.test.ts`/`invoice-form-bridge.unit.test.ts` 核固定字段、dirty/revision、原调用/目标和原回执；`core/application/invoice-form.integration.test.ts` 核已应用后保存故障、未知及迟到补证。010旧库升级/人工来源/事务与导出引用由storage集成验证，受控模型响应不证明真实发票质量。

`desktop.e2e.test.ts` 还在 Main 的真实 Workspace IPC 上控制提交顺序，复现 New chat and send 与切换会话并发读取旧 revision 导致漏发；共享 Renderer 更新队列修复后，仍核对新 Session 身份、原输入、旧历史不混入和仅一次请求，不靠增加模型重试掩盖冲突。

[dev.integration.test.ts](desktop/dev.integration.test.ts) 使用真实临时 Main/Host 链，在开发私有回执位置注入失败、错 requestId 和启动失败，核验 Launcher 拒绝重启且清理自有构建资源；回执替身只证明协议决策，不能证明 Runtime 停止。`host-client.integration.test.ts` 另外用实际协议子进程验证 stdout 积压后正常退出的 ACK 仍能读取，ACK 但进程仍活着不能视为已关闭，无 ACK 崩溃仍是停止未确认。

`provider-boundary.integration.test.ts` 核验公共 Application 的准入及解析副本，直接调用不依赖桌面预检；真实 SQLite 的原 Run 配置不会随调用方对象改变。`transport-options.unit.test.ts` 通过 Pi 公开流方法的替身核验 Provider/Agent 的 fetch 选项，不证明真实厂商兼容；真实 Pi 与回环 HTTP 的接合由 Integration 单独验证。SDK 无公开 usage 存在性证据时保持部分／未知，不为了测试填满数值。

单文件调试：`bun --no-env-file test --isolate ./tests/core/storage/storage.integration.test.ts`。日常入口限制继承的环境变量，子进程禁用 `.env`；受控端点只监听回环地址。只清理测试自身临时根，连接、服务器、计时器和子进程在 finally 或清理钩子中关闭。

历史 `F-*` 名称是工程检查标识，不是 Agent 分类。旧独立 Provider 脚本的有效断言已迁入 runtime-pi 集成测试；Mock 和故障注入不构成模拟 Agent Benchmark。

状态增量检查位于 `core/application/provider-boundary.integration.test.ts`、`core/runtime/lifecycle.integration.test.ts`、`core/application/cold-start-recovery.integration.test.ts` 与 `desktop/desktop.e2e.test.ts`。真实 SQLite 触发器核 create/start/finish 失败后的最后提交行；公共查询与独立 SQL 核取消受理、停止、迟到用量及终态不变；重开同一隔离库核 Run／ToolCall 的必要停止和 Session 局部历史禁用，恢复保存失败必须回滚。桌面通过真实 Electron 核实际 Runtime 门槛与旧查询／Host 响应，不把 UI busy 当作可执行证据；这些检查不产生业务 Case、Benchmark 或平台成绩。

同一桌面回归还将实际保存前的配置快照延后投递，核新配置/凭据不回退；延迟已真实提交的删除模型回复，再投递受控 Host 不可用状态，核旧闭包不能重开 Host/Runtime 准入。受控可用性事件只验证接收规则，不证明真实 Host 崩溃或完整 P16 恢复。

开发期间持续工程验证；完整 Agent 后才运行 `eval:smoke/full`，不包含在 `test` 中。详见 [公开评测指南](../docs/public/EVALUATION.zh-CN.md)。
