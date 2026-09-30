# 工程测试

模块优先，后缀分层；不依赖业务 Benchmark，不读取正式用户数据、不调用付费模型或 Langfuse。

| 目录 | 内容 |
|---|---|
| contracts/ | 输入、错误与状态契约 |
| shared/ | Windows 路径与创建边界、控制锁、系统凭据适配、日志 |
| core/configuration/ | 配置解析 |
| core/storage/ | SQLite、终态、真实 Bun 子进程崩溃后重开、损坏、单写者 |
| core/runtime/ | 生命周期、输出限制、取消竞争、迟到与实际停止 |
| core/application/ | 应用门面与真实组装 |
| runtime-pi/ | SDK 接合、受控 Provider 的协议和故障场景 |
| desktop/ | 白名单与消息投影、真实 Electron/Preload/Main/Bun Host、开发重建和退出、隔离 SQLite E2E |
| data/、employee-invoice/、logging/ | 后续阶段的材料登记、发票规则与安全 Prompt Trace 回归 |
| support/ | 受控请求、临时资源与失败清理 |

使用 `.unit.test.ts`、`.integration.test.ts`、`.e2e.test.ts`。Unit 是局部行为；Integration 是真实组件接合，外部服务使用替身。Provider CLI 及专属测试已在 P3 退役，当前交互使用桌面。Desktop E2E 经 Electron、Preload、Main、Bun Host、公共 Application、Pi 和本地合成 HTTP Provider，使用独立临时 userData/SQLite，验证配置、显式 Provider 诊断、现行 Session 对话及持久查询。窗口关闭、Quit、Main 退出与 Host 崩溃分别核验；进程被杀只证明中断恢复，不能证明正确停止。所有工程测试都不请求真实 Provider，也不运行 Agent 评测。

```powershell
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:e2e
bun run test
```

`test` 按类型→单元→集成→桌面构建→E2E 顺序运行，失败返回非零。类型检查包含评测设施测试。[scripts/test.ts](../scripts/test.ts) 只发现后缀并调用 Bun `test --isolate`，零文件和未分类测试报错，不排除存储、生命周期或组装。

[dev.e2e.test.ts](desktop/dev.e2e.test.ts) 在自有临时目录复制源码，连接已安装依赖，运行真实开发入口；检查初始及后续构建失败不启动、Main/Preload 重建前停止原请求、原 Run 保留、无自动重放，以及退出后的端点与锁释放。Windows 的 `kill('SIGINT')` 是强制结束；该测试通过进程内事件触发已注册的 SIGINT 处理分支，实际控制台 Ctrl+C 的传播仍以本机操作为准。

[dev.integration.test.ts](desktop/dev.integration.test.ts) 使用真实临时 Main/Host 链，在开发私有回执位置注入失败、错 requestId 和启动失败，核验 Launcher 拒绝重启且清理自有构建资源；回执替身只证明协议决策，不能证明 Runtime 停止。`host-client.integration.test.ts` 另外用实际协议子进程验证 stdout 积压后正常退出的 ACK 仍能读取，ACK 但进程仍活着不能视为已关闭，无 ACK 崩溃仍是停止未确认。

`provider-boundary.integration.test.ts` 核验公共 Application 的准入及解析副本，直接调用不依赖桌面预检；真实 SQLite 的原 Run 配置不会随调用方对象改变。`transport-options.unit.test.ts` 通过 Pi 公开流方法的替身核验 Provider/Agent 的 fetch 选项，不证明真实厂商兼容；真实 Pi 与回环 HTTP 的接合由 Integration 单独验证。SDK 无公开 usage 存在性证据时保持部分／未知，不为了测试填满数值。

单文件调试：`bun --no-env-file test --isolate ./tests/core/storage/storage.integration.test.ts`。日常入口限制继承的环境变量，子进程禁用 `.env`；受控端点只监听回环地址。只清理测试自身临时根，连接、服务器、计时器和子进程在 finally 或清理钩子中关闭。

历史 `F-*` 名称是工程检查标识，不是 Agent 分类。旧独立 Provider 脚本的有效断言已迁入 runtime-pi 集成测试；Mock 和故障注入不构成模拟 Agent Benchmark。

开发期间持续工程验证；完整 Agent 后才运行 `eval:smoke/full`，不包含在 `test` 中。详见 [总方案](../docs/eval/01_Flowmate_Agent评测总方案_v1.md)。
