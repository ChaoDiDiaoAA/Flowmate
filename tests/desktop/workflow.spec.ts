import { test, expect, _electron as electron } from "@playwright/test";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { withSourceFixture } from "../support/workspace";
import { inspectSource, freezeDataset } from "@flowmate/data";
import { freezeCandidate } from "@flowmate/core";

const fixtureEntry = resolve("tests/desktop/fixture-main.mjs");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function withDesktop(fn: (config: string, root: string) => Promise<void>) {
  await withSourceFixture("normal", async ({ root, roleMap }) => {
    const manifest = await freezeDataset(await inspectSource(root, roleMap), { "SYN-001": "development" }, { outputRoot: join(root, "frozen") });
    const candidate = freezeCandidate({
      schemaVersion: "1", appSourceHash: hash("desktop-fixture"), lockHash: hash("lock"), runtimeLockHash: hash("runtime"),
      datasetVersion: manifest.datasetVersion, modelProfileHash: hash("controlled"), promptHash: hash("prompt"),
      toolVersions: { read_parsed_document: "1", read_evidence: "1", submit_invoice_candidate: "1" }, extensionVersions: {},
      environment: "local-test", budget: { maxModelRequests: 12, maxToolCalls: 20, wallTimeMs: 30_000 }, eligibility: "test",
    });
    await writeFile(join(root, "candidate.json"), JSON.stringify(candidate));
    await writeFile(join(root, "profile.json"), JSON.stringify({ profileId: "desktop-controlled", environment: "local-test", available: true, mode: "controlled", modelProfileHash: hash("controlled") }));
    const config = join(root, "desktop.json");
    await writeFile(config, JSON.stringify({ manifestRoot: "frozen", candidatePath: "candidate.json", profilePath: "profile.json", dataRoot: "state" }));
    await fn(config, root);
  });
}

async function launch(config: string, root: string, flags: Record<string, string> = {}) {
  const application = await electron.launch({ args: [fixtureEntry, `--user-data-dir=${join(root, "user-data")}`], env: { ...process.env, FLOWMATE_DESKTOP_CONFIG: config, ...flags } });
  const page = await application.firstWindow();
  await expect(page.getByText("desktop-controlled", { exact: true })).toBeVisible();
  await page.getByLabel("选择已解析文件").selectOption("SYN-001");
  return { application, page };
}

test("real Pi extraction crosses IPC, persists evidence, and survives an Electron restart", async () => {
  await withDesktop(async (config, root) => {
    let { application, page } = await launch(config, root);
    try {
      await page.getByRole("button", { name: "开始抽取", exact: true }).click();
      await expect(page.getByText("候选已接受", { exact: true })).toBeVisible();
      await expect(page.locator(".field strong", { hasText: "SYN-001" })).toBeVisible();
      await expect(page.locator(".evidence-block")).toContainText("Invoice No: SYN-001");
      const jobId = await page.locator(".run-id").innerText();
      const snapshot = await page.evaluate((id) => window.flowmate.getJob({ jobId: id }), jobId);
      expect(snapshot).toMatchObject({ job: { status: "candidate_ready" }, runs: [{ sessionId: expect.any(String) }] });
      const versions = await application.evaluate(() => ({ node: process.versions.node, modules: process.versions.modules, electron: process.versions.electron }));
      await test.info().attach("electron-runtime", { body: JSON.stringify(versions), contentType: "application/json" });
      await application.close();
      ({ application, page } = await launch(config, root));
      await expect(page.locator(".run-id")).toHaveText(jobId);
      await expect(page.getByText("候选已接受", { exact: true })).toBeVisible();
      await expect(page.locator(".evidence-block")).toContainText("Invoice No: SYN-001");
    } finally { await application.close(); }
  });
});

test("cancel and window close converge active Pi runs before reopening SQLite", async () => {
  await withDesktop(async (config, root) => {
    let { application, page } = await launch(config, root, { FLOWMATE_TEST_SLOW: "1" });
    try {
      await page.getByRole("button", { name: "开始抽取", exact: true }).click();
      await expect(page.locator(".run-id")).toBeVisible();
      await page.getByRole("button", { name: "请求取消" }).click();
      await expect(page.locator(".status")).toHaveText("cancelled");
      await expect(page.getByText("候选已接受", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "开始抽取", exact: true }).click();
      await expect(page.locator(".status")).toHaveText("running");
      const jobId = await page.locator(".run-id").innerText();
      const closed = application.waitForEvent("close");
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close(); });
      await closed;
      ({ application, page } = await launch(config, root));
      await expect(page.locator(".run-id")).toHaveText(jobId);
      await expect(page.locator(".status")).toHaveText("cancelled");
      const snapshot: any = await page.evaluate((id) => window.flowmate.getJob({ jobId: id }), jobId);
      expect(snapshot.runs[0].cleanupStatus).toBe("complete");
    } finally { await application.close(); }
  });
});

test("invalid IPC and calls from another window are rejected by the main process", async () => {
  await withDesktop(async (config, root) => {
    const { application, page } = await launch(config, root);
    try {
      const message = await page.evaluate(async () => { try { await window.flowmate.start({ sampleId: "", candidateId: "wrong", clientRequestId: "invalid" }); return "accepted"; } catch (error) { return String(error); } });
      expect(message).toContain("IPC_ARGUMENT_INVALID");
      const rejected = await application.evaluate(async ({ BrowserWindow }, preload) => {
        const other = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
        try {
          await other.loadURL("data:text/html,<h1>untrusted</h1>");
          return await other.webContents.executeJavaScript("window.flowmate.listSamples().then(() => 'accepted', error => String(error))");
        } finally { other.destroy(); }
      }, resolve("out/preload/index.cjs"));
      expect(rejected).toContain("IPC_SENDER_REJECTED");
    } finally { await application.close(); }
  });
});

test("concurrent start requests allow only one active run for a sample", async () => {
  await withDesktop(async (config, root) => {
    const { application, page } = await launch(config, root, { FLOWMATE_TEST_SLOW: "1" });
    try {
      const results = await page.evaluate(async () => {
        const { candidateId } = await window.flowmate.getDiagnostics() as { candidateId: string };
        const command = { sampleId: "SYN-001", candidateId, clientRequestId: "same-click" };
        return Promise.allSettled([window.flowmate.start(command), window.flowmate.start(command), window.flowmate.start({ ...command, clientRequestId: "second-click" })]);
      });
      expect(results[0]).toMatchObject({ status: "fulfilled" });
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toMatchObject({ status: "rejected" });
    } finally { await application.close(); }
  });
});

test("Electron runs the native Agent tool and cleans up its actual child Session", async () => {
  await withDesktop(async (config, root) => {
    const { application, page } = await launch(config, root, { FLOWMATE_TEST_SUBAGENT: "1" });
    try {
      await page.getByRole("button", { name: "开始抽取", exact: true }).click();
      await expect(page.getByText("候选已接受", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => application.evaluate(() => (globalThis as any).__flowmateDesktopProbe.length)).toBe(1);
      const results: any = await application.evaluate(() => (globalThis as any).__flowmateDesktopProbe);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ status: "succeeded", cleanupStatus: "complete", toolCallId: expect.any(String), parentSessionId: expect.any(String), childSessionId: expect.any(String) });
      expect(results[0].childSessionId).not.toBe(results[0].parentSessionId);
      await test.info().attach("native-child-session", { body: JSON.stringify(results), contentType: "application/json" });
    } finally { await application.close(); }
  });
});

test("production entry rejects a controlled Profile instead of silently using a fake model", async () => {
  await withDesktop(async (config, root) => {
    const application = await electron.launch({ args: [resolve("out/main/index.js"), `--user-data-dir=${join(root, "production-user-data")}`], env: { ...process.env, FLOWMATE_DESKTOP_CONFIG: config } });
    const child = application.process();
    try {
      await application.waitForEvent("close");
      await expect.poll(() => child.exitCode).toBe(1);
    } finally { await application.close(); }
  });
});
