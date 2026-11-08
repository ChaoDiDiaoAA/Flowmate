# Flowmate 云端服务文件

这些文件是发票 Personal Agent 混合模式的 Ubuntu 部署模板。每个目标服务器都需要单独验证服务、权限隔离、SSH 和恢复流程。生成包的命令在 Linux x86_64、Bun 1.4.4 环境执行：

```sh
bun --no-env-file run scripts/package-cloud.ts /绝对路径/新目录
```

输出目录必须不存在。包包含 Authority、Runtime、Work SSH 桥、OpenViking 管理 SSH 桥、数据库迁移、受管资源和本目录模板，不包含本机方案目录、SSH 密钥或模型凭据。Bun 可执行文件需另行准备。模板使用 `/opt/flowmate/bin/bun`，包安装位置为 `/opt/flowmate/cloud`。

实际部署前需要管理员创建 `flowmate-authority`、`flowmate-runtime` 两个服务账号及 `flowmate-bridge` 受限 SSH 账号，并创建同名组。`flowmate.conf` 由 systemd-tmpfiles 创建三处套接字目录：各目录由对应服务拥有，并以 setgid 继承指定的连接组；组不能修改目录。Authority 与 Runtime 的产品数据分别使用 systemd 创建的私有 StateDirectory。

将两个示例 JSON 分别复制为 `/etc/flowmate/authority.json` 和 `/etc/flowmate/runtime.json`。生成并填入自己的稳定工作区 UUID，按实际 DeepSeek 模型能力调整模型名和上下文参数；两个文件中的套接字路径必须保持一致。配置文件不能包含 API Key。模板通过 `LoadCredential` 从 `/etc/flowmate/credentials/deepseek-api-key` 读取密钥，源文件应仅允许管理员读取，凭据目录由 systemd 向 Authority 提供。Runtime 不读取该密钥。

### 可选 OpenViking 记忆连接

仅在准备好独立的 OpenViking Server `0.4.23`、模型依赖、普通用户及其凭据后，为 Authority 配置 `memory` 对象；未配置时继续原有行为。使用云主机自己的回环端口，不能指向 Windows 或 WeKnora 的现有实例：

```json
"memory": {
  "endpoint": "http://127.0.0.1:19338",
  "accountId": "your-account",
  "userId": "your-user",
  "peerId": "flowmate-agent",
  "recallEnabled": false,
  "captureMode": "off"
}
```

上述对象是现有 Authority JSON 的一个顶层字段，不包含密钥。经管理员授权配置时，可在 Authority 的 systemd drop-in 中增加 `LoadCredential=openviking-user-key:/etc/flowmate/credentials/openviking-user-key`；保留已有 DeepSeek 凭据配置，并使源文件仅对管理员可读。Authority 从 systemd 提供的凭据目录读取普通用户密钥，验证服务版本和 account/user；不把密钥交给 Runtime 或桌面。不要使用 account-admin 或 Root 密钥。

首次配置只在记忆设置 revision 为 0 时初始化；此后通过桌面设置修改策略，修改示例 JSON 不会覆盖已保存策略。云端 Work 可使用已授权记忆和显式保存；发票 Work 自动提炼仍关闭。可选服务、模型和数据目录应独立备份，Flowmate 的 SQLite 备份不包含 OpenViking 外部数据。schema 027 不能由仅支持 026 的旧程序直接打开；升级或回退前需按下方备份要求成对准备程序和数据。

将 `flowmate.conf` 安装到 tmpfiles 配置目录，将两个 service 文件安装到 systemd 单元目录，再由管理员创建目录、重载单元并启用服务。Runtime 的单元仅允许 `AF_UNIX`，Authority 可使用 IP 网络访问 DeepSeek；这一隔离必须在目标系统上实际验证。异常退出后的重启间隔为 20 秒，覆盖现有控制者租约的 15 秒失效时间。

SSH 账号只允许已核实的公钥，`authorized_keys` 应使用 `restrict` 和固定强制命令 `/opt/flowmate/bin/bun --no-env-file /opt/flowmate/cloud/cloud-desktop-bridge.js`；禁止交互 shell、PTY 和转发。桌面必须通过可信渠道核对服务器主机公钥，再配置专用私钥和 known_hosts。阿里云安全组应按确认过的可信来源限制 SSH；不开放 Authority 或 Runtime 的公网业务端口。

### 可选 OpenViking 云端管理

专用管理入口由现有 Authority 进程提供。通过 `authority.json` 的可选顶层字段 `openVikingManagement` 启用需要的角色。下面是启用三个角色的示例。

```json
"openVikingManagement": {
  "endpoint": "http://127.0.0.1:19338",
  "P": { "accountId": "your-account", "userId": "your-user", "peerId": "flowmate-agent" },
  "A": { "accountId": "your-account", "userId": "your-admin" },
  "S": true
}
```

每个启用的角色需要单独的 SSH 账号、系统组和 OpenViking 密钥。使用 [套接字目录示例](openviking-management.tmpfiles.example) 中对应角色的条目。目录由 Authority 所有，setgid 继承该角色的组。各 SSH 账号只加入自己的管理组，Work 桥和 Runtime 账号不加入管理组。Authority 的 systemd drop-in 按角色添加 `ReadWritePaths=/run/flowmate-openviking-p` 等目录和 `LoadCredential=openviking-management-p-key:/etc/flowmate/credentials/openviking-management-p-key` 等凭据。A、S 分别使用名称中的 `a`、`s`。凭据源文件仅对管理员可读。未配置该字段时，旧 Work 桥和记忆连接照常启动。

为每个角色配置自己的 `authorized_keys` 和强制命令。例如 P 使用 `restrict,command="/opt/flowmate/bin/bun --no-env-file /opt/flowmate/cloud/cloud-openviking-bridge.js P"`，A 和 S 使用各自固定的末尾角色。角色由目标套接字决定，命令请求体不携带角色或密钥。握手核对 OpenViking Server 版本与账号身份。已提交操作按原 ID 核对，收到未知结果时不会重发修改。分块文件与操作回执保存在 Authority 的私有 StateDirectory。传输完成后由原管理连接释放文件。备份该目录时使用与现有业务数据相同的访问限制。

桌面的 Personal Agent 默认打开云工作区，尝试启动本机 Windows KimiCU，并在已有连接配置时自动重连；也可切换到本地工作区。首次连接云工作区时填写服务端工作区 UUID、主机、受限 SSH 用户、专用私钥和已验证的 known_hosts 路径。选择本地发票后，桌面先传送原件及解析资料，再以云端资料身份创建 Work；选中的 Prompt 和 Skill 也会先按原版本及文件内容传送。创建云 Work 时可设置执行时间预算，默认 120 秒，最多 24 小时；重试保留原预算。已创建的 Work 保持原执行位置，关闭桌面不会停止云端执行。

云端 Work 如需操作当前 Windows 桌面，须使用配套版本的桌面端、Authority、Runtime 和 `cloud-desktop-bridge.js`，并在新 Work 的配置中启用桌面工具。操作前由用户选择目标窗口，逐次确认具体动作；启动或重连不会自动提交 Work 或执行动作。桌面观察结果会经 SSH 发送到云端，可能保存到工作历史或发送给模型服务。具体安装、工具选择及使用限制见项目根目录 README。

云端 Work 的网页读取同样需要上述配套版本和本机 Kimi WebBridge；用户在 Windows 绑定专用 Chrome 标签页并逐次确认。网页读取与 KimiCU 桌面工具在同一 Work 中互斥。页面 URL、标题与正文会经 SSH 进入云端，可能保存到历史并发送给所选模型；使用前请阅读[受控网页读取说明](../../docs/public/personal-agent.zh-CN.md#受控网页读取)。

云端队列可查看并对原输入执行 steer、follow-up、编辑、重排和取消；这些操作仍受原发票及工具授权约束。进度通知触发重读原工作区状态；父任务实时文本只是有界的内存预览，可能不完整，重连或消费落后时丢弃并重新读取快照。观察版本与业务 Work 版本分别显示。原生结果投递耗尽重试后可手动重投原结果，超过大小限制的结果保留在原生记录并显示受阻。长时间连接达到传输请求上限时，重新连接工作区后继续查看原记录。

对已确认的 429、500、502、503 和 504 响应，同一原生检查点最多进行四次模型请求，每次使用独立尝试身份并计入原 Work 预算；401、402 等其他失败不自动重试。若请求是否到达模型服务无法确认，保留原身份并停止自动重发。

升级或备份时先停止新受理并确认未决效果，再成对保存 Authority 数据库与受管文件、所有 Runtime Session 数据库及其回执。独立复制运行中的 SQLite 主文件不构成一致备份；恢复流程也须在目标环境单独验证。

部署时应确认服务器时间同步正常；若系统时间回拨，原有执行时间预算可能无法确认，任务会停止以避免扩大授权。
