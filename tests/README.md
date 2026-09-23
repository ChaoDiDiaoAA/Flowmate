# 工程测试

模块优先，后缀分层；不依赖业务 Benchmark，不读取正式用户数据、不调用付费模型或 Langfuse。

| 目录 | 内容 |
|---|---|
| contracts/ | 输入、错误与状态契约 |
| shared/ | 路径、环境解析、日志 |
| core/configuration/ | 配置解析 |
| core/storage/ | SQLite、终态、重开、损坏、单写者 |
| core/runtime/ | 生命周期、输出限制、取消竞争、迟到与实际停止 |
| core/application/ | 应用门面与真实组装 |
| runtime-pi/ | SDK 接合、受控 Provider 的协议和故障场景 |
| cli/ | 模拟 Application 的 Unit 与真实进程 E2E |
| desktop/ | 真实 Electron/Preload/Main/Bun Host、单轮聊天与隔离 SQLite E2E |
| support/ | 受控请求、临时资源与失败清理 |

使用 `.unit.test.ts`、`.integration.test.ts`、`.e2e.test.ts`。Unit 是局部行为；Integration 是真实组件接合，外部服务使用替身；CLI E2E 经真实 CLI 子进程、composition、Runtime、Pi、受控 HTTP、SQLite，再由另一进程查询。Desktop E2E 经 Electron、Preload、Main、Bun Host、公共 Application、Pi 和本地合成 HTTP Provider，使用独立临时 userData/SQLite，验证配置保存、每条聊天单独调用和 Run 查询。所有工程测试都不请求真实 Provider，也不运行 Agent 评测。

```powershell
bun run typecheck
bun run test:unit
bun run test:integration
bun run test:e2e
bun run test
```

`test` 按类型→单元→集成→E2E 顺序运行，失败返回非零。类型检查包含评测设施测试。[scripts/test.ts](../scripts/test.ts) 只发现后缀并调用 Bun `test --isolate`，零文件和未分类测试报错，不排除存储、生命周期、组装或 CLI。

单文件调试：`bun --no-env-file test --isolate ./tests/core/storage/storage.integration.test.ts`。日常入口限制继承的环境变量，子进程禁用 `.env`；受控端点只监听回环地址。只清理测试自身临时根，连接、服务器、计时器和子进程在 finally 或清理钩子中关闭。

历史 `F-*` 名称是工程检查标识，不是 Agent 分类。旧独立 Provider 脚本的有效断言已迁入 runtime-pi 集成测试；Mock 和故障注入不构成模拟 Agent Benchmark。

开发期间持续工程验证；完整 Agent 后才运行 `eval:smoke/full`，不包含在 `test` 中。详见 [总方案](../docs/eval/01_Flowmate_Agent评测总方案_v1.md)。
