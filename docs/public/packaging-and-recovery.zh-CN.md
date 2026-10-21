[English](packaging-and-recovery.md) | [简体中文](packaging-and-recovery.zh-CN.md) · [文档导航](README.zh-CN.md)

# 打包与恢复

## 构建 Windows 安装包

安装目标为 **Windows x64**，使用 Bun **1.4.0** 与锁定依赖。脚本检查 Pi 0.85.1、pi-subagents 0.19.0、Electron 44.4.5、迁移、原生工具及必需资源。

```powershell
bun install --frozen-lockfile
bun --no-env-file run package:dir
# 或构建 NSIS 安装包：
bun --no-env-file run package:win
```

脚本构建桌面，在 `out/package-stage/` 准备运行资源，electron-builder 输出至 `out/package/` 并关闭发布。NSIS 按用户安装，允许选择目录，安装后不自动运行，卸载不删除应用数据。

运行资源包含 Bun、Host/评测/维护入口、Pi 资源、迁移、作者资源、必需原生文件和许可。`release.json` 保存显式版本与文件清单，安装验证核对实际清单和版本，不回退开发源码或 PATH Bun。必要补丁和许可继续保留，见[开发指南](development.zh-CN.md#dependency-patches)。

## 数据与诊断

默认数据根为 `%APPDATA%\Flowmate`，安装文件与可写产品数据分离。

| 相对位置 | 用途 |
|---|---|
| `data/app.sqlite` | Session、Run、输入、Context 和业务事实 |
| `data/settings.json`、`data/installed-release.json` | 设置与安装发行记录 |
| `artifacts/`、`outputs/` | 受管资料和交付文件 |
| `runtime/resource-bundles/`、`runtime/subagents/` | 原 Run 资源与用户角色 |
| `security/credentials/`、`Local State` | 加密凭据封装与 Electron 密钥材料 |
| `imports/invoices/` | 安装版发票导入来源 |
| `evaluation/agent-eval/runs/` | 安装版本地评测结果 |
| `logs/` | 运行诊断 |

Models/Settings 诊断检查 Provider/Runtime，Activity 查看实际事件和工具，Processing History、Session 详情查看保存事实。`installation_runtime_invalid`、`installation_dependency_missing` 应核对安装包，不回退源码修复。

回复丢失或停止未确认不证明操作没有副作用，保留原 Run/ToolCall/操作 ID，重试前查询。详见 [Runtime](agent-runtime.zh-CN.md)、[Subagent](subagents.zh-CN.md)。

## 离线备份

关闭 Flowmate 和目标根的其他控制者。维护工具取得控制者租约，检查存储、Checkpoint 数据库并验证复制文件。目标是绝对新目录且父目录已存在，只复制活跃 SQLite 文件不能保证 WAL 和关联文件一致。

以下为**安装版运行环境**模板，占位符需替换为实际绝对位置，不使用开发源码入口：

```powershell
$runtime = '<absolute installation resources path>\flowmate-runtime'
$userData = Join-Path $env:APPDATA 'Flowmate'
$backup = '<absolute new backup directory>'
& (Join-Path $runtime 'bin\bun.exe') --no-env-file (Join-Path $runtime 'apps\maintenance.js') backup --user-data-root $userData --destination $backup
```

检查 JSON `result`、`leaseRelease`、退出状态与 `gaps`。Manifest 列出复制路径和字节数，保留选定持久数据、加密凭据与 Local State，不镜像整个根。日志、`.env` 密钥、外部来源目录和外部评测数据集不在完整备份承诺内，必要外部材料另存。

凭据仍依赖 Windows 账户和系统加密环境，加密封装与 Local State 不保证跨账户、跨机器恢复。

## 恢复与验证边界

CLI 提供 `backup` 与 **`verify-restore`**，不提供自动恢复命令。

1. 保留原存储、备份不动，关闭控制者，选择独立离线恢复根。
2. 按相对布局恢复 Manifest 列出的持久文件，包含必需数据、受管产物、资源与加密密钥材料。使用匹配版本，不将旧程序接入已升级库。
3. 使用安装版工具对照原备份检查恢复根：

```powershell
$restoredRoot = '<absolute restored user-data directory>'
& (Join-Path $runtime 'bin\bun.exe') --no-env-file (Join-Path $runtime 'apps\maintenance.js') verify-restore --user-data-root $restoredRoot --backup $backup
```

4. 核对可读性、兼容性及缺口。`runtimeValidation: pending` 表示文件和引用检查尚未验证实时执行；目标账户检查凭据访问，恢复存储获准使用后再显式启动一个安全新 Run。

校验器将恢复持久文件集合、内容、引用与 Manifest 核对，并检查 Schema/设置兼容；不复制文件、重放旧调用、修复历史缺口、证明模型连接或认证业务质量。安装发行变化时，在打开、迁移状态前先备份；失败保留原数据，不宣称恢复成功。

## 源码与验证

[打包脚本](../../scripts/package.ts)、[Builder 配置](../../electron-builder.yml)、[运行布局](../../packages/shared/src/runtime-layout.ts)、[维护 CLI](../../apps/maintenance/main.ts)、[存储维护](../../packages/core/src/storage/maintenance.ts)、[打包测试](../../tests/packaging)、[维护集成测试](../../tests/core/storage/maintenance.integration.test.ts)。

产物生成、安装、升级、备份可读、凭据恢复、新 Run 可执行分别验证，包文件或受控测试不能同时证明全部。
