# Flowmate 云端服务文件

这些文件是发票 Personal Agent 混合模式的 Ubuntu 部署模板。目标服务器上的部署与验收尚未完成，不应作为已验证的生产部署。生成包的命令在 Linux x86_64、Bun 1.4.4 环境执行：

```sh
bun --no-env-file run scripts/package-cloud.ts /绝对路径/新目录
```

输出目录必须不存在。包只包含三个服务入口、数据库迁移、受管资源和本目录模板，不包含本机方案目录、SSH 密钥或模型凭据。Bun 可执行文件需另行准备；模板使用 `/opt/flowmate/bin/bun`，包安装位置为 `/opt/flowmate/cloud`。

实际部署前需要管理员创建 `flowmate-authority`、`flowmate-runtime` 两个服务账号及 `flowmate-bridge` 受限 SSH 账号，并创建同名组。`flowmate.conf` 由 systemd-tmpfiles 创建三处套接字目录：各目录由对应服务拥有，并以 setgid 继承指定的连接组；组不能修改目录。Authority 与 Runtime 的产品数据分别使用 systemd 创建的私有 StateDirectory。

将两个示例 JSON 分别复制为 `/etc/flowmate/authority.json` 和 `/etc/flowmate/runtime.json`。生成并填入自己的稳定工作区 UUID，按实际 DeepSeek 模型能力调整模型名和上下文参数；两个文件中的套接字路径必须保持一致。配置文件不能包含 API Key。模板通过 `LoadCredential` 从 `/etc/flowmate/credentials/deepseek-api-key` 读取密钥，源文件应仅允许管理员读取，凭据目录由 systemd 向 Authority 提供。Runtime 不读取该密钥。

将 `flowmate.conf` 安装到 tmpfiles 配置目录，将两个 service 文件安装到 systemd 单元目录，再由管理员创建目录、重载单元并启用服务。Runtime 的单元仅允许 `AF_UNIX`，Authority 可使用 IP 网络访问 DeepSeek；这一隔离必须在目标系统上实际验证。异常退出后的重启间隔为 20 秒，覆盖现有控制者租约的 15 秒失效时间。

SSH 账号只允许已核实的公钥，`authorized_keys` 应使用 `restrict` 和固定强制命令 `/opt/flowmate/bin/bun --no-env-file /opt/flowmate/cloud/cloud-desktop-bridge.js`；禁止交互 shell、PTY 和转发。桌面必须通过可信渠道核对服务器主机公钥，再配置专用私钥和 known_hosts。阿里云安全组应按确认过的可信来源限制 SSH；不开放 Authority 或 Runtime 的公网业务端口。

桌面的 Personal Agent 可选择本地或云工作区。连接云工作区时填写服务端工作区 UUID、主机、受限 SSH 用户、专用私钥和已验证的 known_hosts 路径。选择本地发票后，桌面先传送原件及解析资料，再以云端资料身份创建 Work；选中的 Prompt 和 Skill 也会先按原版本及文件内容传送。创建云 Work 时可设置执行时间预算，默认 120 秒，最多 24 小时；重试保留原预算。已创建的 Work 保持原执行位置，关闭桌面不会停止云端执行。

云端队列可查看并对原输入执行 steer、follow-up、编辑、重排和取消；这些操作仍受原发票及工具授权约束。进度通知触发重读原工作区状态；父任务实时文本只是有界的内存预览，可能不完整，重连或消费落后时丢弃并重新读取快照。观察版本与业务 Work 版本分别显示。原生结果投递耗尽重试后可手动重投原结果，超过大小限制的结果保留在原生记录并显示受阻。长时间连接达到传输请求上限时，重新连接工作区后继续查看原记录。

对已确认的 429、500、502、503 和 504 响应，同一原生检查点最多进行四次模型请求，每次使用独立尝试身份并计入原 Work 预算；401、402 等其他失败不自动重试。若请求是否到达模型服务无法确认，保留原身份并停止自动重发。

升级或备份时先停止新受理并确认未决效果，再成对保存 Authority 数据库与受管文件、所有 Runtime Session 数据库及其回执。独立复制运行中的 SQLite 主文件不构成一致备份。真实 ECS、systemd 权限隔离、SSH、DeepSeek 和恢复流程仍需单独验证。

部署时应确认服务器时间同步正常；若系统时间回拨，原有执行时间预算可能无法确认，任务会停止以避免扩大授权。
