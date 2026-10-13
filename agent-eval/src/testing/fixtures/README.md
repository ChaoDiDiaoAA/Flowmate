# Flowmate v1 原始样本

参考 Folio 的 `packages/longbridge-tools/src/testing/fixtures`：每份文件是可独立读取的原始数据。JSON 保存解析文档或资源声明，不套完整 Case、答案、评分结果或执行控制器。制作本组样本没有调用模型或付费服务，没有进行 CLI 采集，因此没有 `.cmd.txt` 记录。

Case／Gold／Review 在 `src/datasets/`。初态、授权材料和普通业务控制在 `src/testing/scenarios.ts`；后续用户文本只在 Case `input.turns`，场景使用 `turnId`。Case 的 `input.fixture.name` 选择场景，由场景引用本目录文件或现有发票原件。只把当前获授权输入和选中资源提供给 Agent；源码副本及挂载同时排除 `datasets/`、`testing/`，未来轮次与私有控制留评测侧。

FM-025 的 16 条种子消息也属于实际后续输入，文本在 Case 中；控制声明只引用轮次 ID，最后保存轮次另行引用。不能把运行时提交的对白当作初始历史，或藏进样本文件缩短 Case。

文件名保留逻辑来源路径，将 `/` 换为 `--`，如 `materials/landsat-c2-guide-v4/source.md` 对应 `materials--landsat-c2-guide-v4--source.md`。Gold 保留逻辑路径与精确原文定位，加载器解析回实际字节。资源声明维护自己的文件列表，不另建材料或资源索引。

| 文件组 | 来源与用途 |
|---|---|
| `materials--ipp-multipage-3p-na-3--*` | 现有多页发票及解析页；随附原始来源 README、DATA_LICENSE 保留原文和许可信息 |
| `materials--csv-*`、`materials--json-*` | 本地保存的 RFC 文本及勘误，用于格式／冲突判断；原链接和引文定位仍在 Gold |
| `materials--landsat-*`、`materials--landsat9-*` | 本地保存的 USGS 网页／PDF 指南及摘录，用于产品、修订、缩放和证据链 |
| `materials--viirs-*`、`materials--ghcn-*` | 本地保存的 NASA／NOAA 产品／格式来源及摘录，用于比较和枚举 |
| `materials--earthdata-*`、`materials--hubble-*` | 本地保存的公共来源及摘录，用于费用边界与证据不足任务 |
| `materials--migrant-mother-*`、`materials--lange-*`、`materials--wra-*` | 本地保存的档案／机构网页及摘录，用于多跳证据链 |
| `materials--*-constraints--requirements.md` | 手工编写的本地业务约束，属于受控输入，不冒充外部采集需求 |
| `materials--synthetic-*` | 手工编写的缺字段／版本冲突样本，不是客户记录或真实 CLI 采集 |
| `materials--untrusted-note-*` | 手工编写的对抗性来源文本，其指令只是非可信文档内容，不是评测器指令或私有控制 |
| `resources--*` | 现有或人工改编的 Skill 源码／资源声明；受控长文本和依赖变体是输入，不是 Agent 成功证据；只恢复场景实际选中的资源包 |

发票原件和解析业务记录继续只读引用 `data/invoices/voxel51`，不在这里重复保存；沿用现有来源与许可核对记录。原件、精确引文和原件随附 README 保留原语言。既有记录未证实的再分发权仍标未核验，不把网站公开视为已获再分发许可。

JSON 使用 `loadFixture('materials--ipp-multipage-3p-na-3--pages')`，文本使用 `loadFixtureText('materials--csv-rfc4180--source', 'md')`；二进制原件按字节读取。加载器拒绝非法名称、路径穿越、绝对路径和链接越界，缺失／格式错误明确报错。样本不包含原件 Base64、密钥、哈希或指纹，不给手工样本伪造命令、采集日期或独立人工批准。
