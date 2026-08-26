# Flowmate Data Workbench

职责：P0采集、原始保存、MinerU解析、去重、Policy、Catalog、Release、Backup

非职责：Flowmate Runtime、生产OCR、企业最终验收

阶段位置：P0，P1硬前置

输入：SourcePolicy、OpenCLI结果、公开文件

输出：DatasetManifest、Obsidian卡片、Raw/Derived Archive

根命令：data:init/discover/acquire/catalog:flush/publish/backup/restore:verify

测试：npm test、lint、typecheck、build

安全：PUBLIC/read、200文件、MinerU云上传、无密钥

失败：停止条件和证据位置

下一步：[P0 Spec](../../.superpowers/sdd/P0_Obsidian数据库实施计划/)和[P0 Plan](../../.superpowers/sdd/P0_Obsidian数据库实施计划/task-1-brief.md)链接

## Commands

- `data:init`
- `data:discover`
- `data:acquire`
- `data:catalog:flush`
- `data:publish`
- `data:backup`
- `data:restore:verify`
