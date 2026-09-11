# Flowmate Desktop

Electron 主进程组装 Application 并通过受限 preload IPC 提供 P0 操作界面。Renderer 不持有数据库、凭证或 Pi SDK；未配置冻结清单和运行 Profile 时，界面保持明确的未就绪状态。
