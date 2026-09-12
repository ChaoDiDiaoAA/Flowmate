# Flowmate Desktop

Electron 主进程组装 Application 并通过受限 preload IPC 提供 P0 操作界面。Renderer 不持有数据库、凭证或 Pi SDK；未配置冻结清单和运行 Profile 时，界面保持明确的未就绪状态。

从仓库根目录运行：

```powershell
bunx install-electron --no
bun run build
$env:FLOWMATE_DESKTOP_CONFIG = 'D:\code\Flowmate\config\desktop.local.json'
bunx electron out/main/index.js
```

按 `config/desktop.example.json` 准备本地配置，指向已冻结的数据清单、TestCandidate、Live Profile 和可写数据目录。配置中的路径相对于配置文件所在目录；Profile 中的 authPath/modelsPath 相对于 Profile 文件所在目录。Profile 必须明确 mode=live、environment=local-test、available=true 和 modelRef；内置 Provider 可以只使用 Pi 原生环境认证，自定义 Provider 才需要 `modelsPath`。`modelsPath` 用于 Pi 的自定义 Provider/模型配置，其中的 `apiKey` 可以引用本机环境变量。凭证文件只由主进程使用。Runtime 会从 Pi 实际解析的模型生成脱敏配置快照和摘要，作为运行证据，不要求在 Flowmate Profile 重复填写 Provider/API/能力。

未设置配置时显示空样本与 unavailable；设置了无效配置时启动失败并返回非零退出码，不退回受控模型。业务样本还必须通过候选/数据/授权检查。

`bun run test:desktop` 运行实际 Electron。测试使用独立用户数据目录、冻结合成数据、真实 Pi Session 与显式受控 Provider，覆盖 preload/IPC、抽取与证据、SQLite 重开、取消/关闭清理、重复请求及原生 Agent 子 Session。受控 Provider 只位于测试入口，不表示真实模型质量评估。缺少二进制时测试直接失败。

Windows 中测试需要允许创建 Electron 渲染器/GPU 子进程的执行环境。2026-09-12 的对照结果：Codex 执行沙箱内出现 launch-failed，沙箱外保持 Electron sandbox=true、contextIsolation=true、nodeIntegration=false 和默认 GPU 设置即可通过；不需要禁用 Electron 沙箱或修改系统显卡驱动。
