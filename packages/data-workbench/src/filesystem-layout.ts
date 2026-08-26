import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DataPaths {
  root: string;
  vault: string;
  staging: string;
  webRaw: string;
  derivedMineru: string;
  manifests: string;
  releases: string;
  quarantine: string;
  failures: string;
  backups: string;
}

const rootReadme = `# FlowmateData

## 目录职责和完整树

此目录是 P0 数据工作台的仓库外数据根目录，不属于 Flowmate 源码或 Git 历史。

\`\`\`text
FlowmateData/
├─ vault/
├─ staging/
├─ web-raw/
├─ derived/{mineru,html,native}/
├─ files/{public,private-raw,private-sanitized}/
├─ labels/
├─ manifests/
├─ releases/
├─ quarantine/
├─ failures/
└─ backups/
\`\`\`

## 数据安全和不变量

- \`web-raw\` 中的网络原始内容不可原地修改；任何转换都必须写入 \`derived\`。
- \`files/private-raw\` 禁止进入 Git，也禁止上传到未经批准的云服务。
- \`derived\` 是解析器输出，不是人工正确答案；人工标签保存在 \`labels\`。
- \`quarantine\` 中的内容不能发布到 Dataset Release。

## 备份、恢复与删除审计

- 备份在 \`backups\` 中保存清单和校验信息；恢复必须在隔离目录校验 hash 后才可使用。
- 被策略禁止留存的正文和文件必须删除，只保留来源、hash、时间和拒绝原因等审计元数据。
- 删除、隔离和恢复操作必须保留可追踪的审计记录；不得以覆盖或清空目录代替审计删除。
`;

const vaultReadme = `# Flowmate Obsidian Vault

## 职责

此 Vault 只保存 P0 的可检索元数据和 Markdown 卡片：公开知识库、公开样本库与真实业务资产库。大型原始文件和派生文件保存在 Vault 外的数据目录。

## 目录与标识

- \`10_Sources\`、\`20_AcquisitionJobs\` 和 \`60_DatasetReleases\` 分别保存 Source、Job 和 Release 卡片。
- 卡片使用 Obsidian Properties，并使用稳定 ID（例如 \`SRC-*\`、\`ACQ-*\`、\`ART-*\`、\`KNOW-*\`、\`SAMPLE-*\`、\`BIZ-*\`）。
- Obsidian Bases 以这些 Properties 和逻辑目录为入口，不复制原始资产作为附件。

## Vault 外文件

\`web-raw\`、\`derived\`、\`files\`、\`labels\`、\`manifests\`、\`releases\`、\`quarantine\`、\`failures\` 与 \`backups\` 都保存在 FlowmateData 根目录的 Vault 外；卡片只能引用其稳定路径和 SHA-256。
`;

async function writeReadmeIfMissing(
  readmePath: string,
  contents: string,
): Promise<void> {
  try {
    await writeFile(readmePath, contents, { encoding: "utf8", flag: "wx" });
  } catch (error: unknown) {
    if (!(error instanceof Error) || "code" in error === false || error.code !== "EEXIST") {
      throw error;
    }
  }
}

export async function initializeDataLayout(root: string): Promise<DataPaths> {
  const resolvedRoot = path.resolve(root);
  const paths: DataPaths = {
    root: resolvedRoot,
    vault: path.join(resolvedRoot, "vault"),
    staging: path.join(resolvedRoot, "staging"),
    webRaw: path.join(resolvedRoot, "web-raw"),
    derivedMineru: path.join(resolvedRoot, "derived", "mineru"),
    manifests: path.join(resolvedRoot, "manifests"),
    releases: path.join(resolvedRoot, "releases"),
    quarantine: path.join(resolvedRoot, "quarantine"),
    failures: path.join(resolvedRoot, "failures"),
    backups: path.join(resolvedRoot, "backups"),
  };
  const directories = [
    paths.root,
    paths.vault,
    paths.staging,
    paths.webRaw,
    paths.derivedMineru,
    path.join(paths.root, "derived", "html"),
    path.join(paths.root, "derived", "native"),
    path.join(paths.root, "files", "public"),
    path.join(paths.root, "files", "private-raw"),
    path.join(paths.root, "files", "private-sanitized"),
    path.join(paths.root, "labels"),
    paths.manifests,
    paths.releases,
    paths.quarantine,
    paths.failures,
    paths.backups,
  ];

  await Promise.all(directories.map(async (directory) => mkdir(directory, { recursive: true })));
  await writeReadmeIfMissing(path.join(paths.root, "README.md"), rootReadme);
  await writeReadmeIfMissing(path.join(paths.vault, "README.md"), vaultReadme);

  return paths;
}
