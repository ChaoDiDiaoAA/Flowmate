[English](development.md) | [简体中文](development.zh-CN.md) · [文档导航](README.zh-CN.md)

# 开发指南

## 环境与入口

使用 Windows x64、Node.js 24 和 Bun 1.4.4。AgentSession 与 Durable 统一固定 Pi SDK 1.4.0，另固定 pi-subagents 0.19.0、Electron 44.4.5、React 19.3.0、TypeScript 5.8.3。在仓库根执行：

```powershell
bun install --frozen-lockfile
bun run dev
```

Node 开发入口管理初始构建、就绪、Electron 生命周期及 Main/Preload 重启，Renderer 热更新。替换自有运行环境前正常关闭当前进程，不能将杀进程视为应用已确认关闭。

## 源码组织

层次边界见[架构](architecture.zh-CN.md)。`apps/composition.ts` 与 `apps/personal-agent.ts` 组装共用产品服务。`apps/desktop` 是界面与进程壳，`apps/host` 持有本地 Bun 协议，`apps/service` 是独立 ServiceOwner。`packages/runtime-pi` 为 Chats/Invoices/Deep Research 保留 AgentSession，`packages/runtime-durable` 负责 Personal Agent 原生 Task 与恢复；两者复用 Application、ToolExecutor、Workspace、Context 及协调后的 SQLite 存储。其他包区分契约、资料、发票规则、日志、共享路径与安全。`resources/` 是作者资源，`tests/` 是工程检查，`agent-eval/` 为隔离质量设施。

行为修改沿输入契约、公开 Application/Host/Preload、Runtime/适配器及相关存储、领域消费者检查，模型工具调用保持经过产品执行器。父子实现入口汇总在 [Subagent](subagents.zh-CN.md#developer-map-and-verification)。

## 工程验证

```powershell
bun --no-env-file run typecheck
bun --no-env-file run test:unit
bun --no-env-file run test:integration
bun --no-env-file run build:desktop
bun --no-env-file run test:e2e
```

`bun --no-env-file run test` 按类型检查 → Unit → Integration → 桌面构建 → Electron E2E 执行。按 `.unit.test.ts`、`.integration.test.ts`、`.e2e.test.ts` 发现，Unit/Integration 使用 Bun 文件隔离，Electron 使用已安装 Node/Playwright 路径和一个 worker。

局部调试：

```powershell
bun --no-env-file test --isolate ./tests/core/storage/storage.integration.test.ts
```

工程夹具使用临时根和受控 Provider，不读取正式用户数据或运行真实模型 Benchmark。覆盖和清理职责见 [tests/README.md](../../tests/README.md)、[评测设施测试](../../agent-eval/tests/README.md)。付费评测不作为附带步骤，独立配置与费用见[评测](EVALUATION.zh-CN.md)。

2026-10-30 已记录的工程基线为 typecheck 通过、Unit `1041 pass / 0 fail`、Integration `2503 pass / 1 skip / 0 fail`、Electron E2E `137 passed / 1 skipped`，标准 `bun --no-env-file run test` 命令 exit 0。本次文稿收口复用该证据，只进行文档静态核对；skip 仍是未运行项。真实 SCM 安装/启动、开机、升级/回退及关闭桌面后持续运行延期验收，真实模型语义与用户收益仍未验证。

<a id="dependency-patches"></a>

## 依赖补丁

根 `patchedDependencies` 和锁文件引用：

- `patches/@earendil-works%2Fpi-coding-agent@1.4.0.patch`
- `patches/@tintinweb%2Fpi-subagents@0.19.0.patch`

Pi 接合依赖补丁提供的受管 Session、工具、历史钩子和受控子执行路径，是安装与运行必需输入。删补丁但保留清单、锁引用会破坏安装；删引用但不替换消费者会破坏运行保证。依赖、补丁和消费者同步更新，再验证受影响的实际适配器、产品测试。

[licenses](../../licenses) 中的文件由 [scripts/package.ts](../../scripts/package.ts) 复制，与必需 SDK、原生资源一起保留。产物生成不认证安装、升级或恢复，见[打包与恢复](packaging-and-recovery.zh-CN.md)。

## 文档与 Git 范围

公开专题位于 `docs/public/`，英文 `.md`、中文 `.zh-CN.md` 成对互链，行为变化同时更新。链接需在发布仓库内成立，开发者本地文件不能成为公开阅读依赖。

内部评测、计划、提示和规格目录由精确根规则忽略，`.zread/` 和分析缓存继续排除。不要强制加入或合并清理前历史来同步旧克隆，远端替换后重新克隆。测试数据来源标识与实际文档导航分开。

GitHub 可读 Markdown 与 Mermaid 无需文档站框架或构建依赖。
