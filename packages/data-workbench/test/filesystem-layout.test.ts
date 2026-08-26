import { access, appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { initializeDataLayout } from "../src/filesystem-layout.js";

const temporaryRoots: string[] = [];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "..", "..");

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "flowmate-data-layout-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => rm(root, { force: true, recursive: true })),
  );
});

describe("initializeDataLayout", () => {
  it("creates every required P0 data location", async () => {
    const root = await createTemporaryRoot();

    const paths = await initializeDataLayout(root);

    expect(paths).toEqual({
      root,
      vault: path.join(root, "vault"),
      staging: path.join(root, "staging"),
      webRaw: path.join(root, "web-raw"),
      derivedMineru: path.join(root, "derived", "mineru"),
      manifests: path.join(root, "manifests"),
      releases: path.join(root, "releases"),
      quarantine: path.join(root, "quarantine"),
      failures: path.join(root, "failures"),
      backups: path.join(root, "backups"),
    });

    const requiredPaths = [
      "vault",
      "staging",
      "web-raw",
      "derived/mineru",
      "derived/html",
      "derived/native",
      "files/public",
      "files/private-raw",
      "files/private-sanitized",
      "labels",
      "manifests",
      "releases",
      "quarantine",
      "failures",
      "backups",
      "README.md",
      "vault/README.md",
    ];

    await Promise.all(
      requiredPaths.map(async (relativePath) => access(path.join(root, relativePath))),
    );
  });

  it("preserves existing artifacts and README additions on a repeat initialization", async () => {
    const root = await createTemporaryRoot();
    await initializeDataLayout(root);
    const artifactPath = path.join(root, "staging", "existing-artifact.json");
    const rootReadmePath = path.join(root, "README.md");
    const vaultReadmePath = path.join(root, "vault", "README.md");

    await writeFile(artifactPath, "preserve this artifact\n", "utf8");
    await appendFile(rootReadmePath, "\nUser root note\n", "utf8");
    await appendFile(vaultReadmePath, "\nUser vault note\n", "utf8");

    await initializeDataLayout(root);

    await expect(readFile(artifactPath, "utf8")).resolves.toBe("preserve this artifact\n");
    await expect(readFile(rootReadmePath, "utf8")).resolves.toContain("User root note");
    await expect(readFile(vaultReadmePath, "utf8")).resolves.toContain("User vault note");
  });

  it("documents both README locations and staging outside the Vault", async () => {
    const root = await createTemporaryRoot();
    await initializeDataLayout(root);

    const rootReadme = await readFile(path.join(root, "README.md"), "utf8");
    const vaultReadme = await readFile(path.join(root, "vault", "README.md"), "utf8");

    expect(rootReadme).toContain("├─ README.md");
    expect(rootReadme).toContain("│  └─ README.md");
    expect(vaultReadme).toContain("`staging`");
  });
});

describe("data-workbench CLI", () => {
  it("returns a nonzero exit code for an unknown command", () => {
    const result = spawnSync(
      process.execPath,
      [
        path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(packageRoot, "src", "cli.ts"),
        "unknown",
      ],
      { cwd: packageRoot, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown data-workbench command: unknown");
  });
});
