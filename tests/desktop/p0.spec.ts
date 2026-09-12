import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

let application: ElectronApplication;
let page: Page;
let userData: string;

test.beforeEach(async () => {
  const main = resolve(process.cwd(), "out/main/index.js");
  await access(main, constants.R_OK);
  const electronBinary = resolve(process.cwd(), "node_modules/electron", process.platform === "win32" ? "dist/electron.exe" : "dist/electron");
  await access(electronBinary, constants.X_OK);
  userData = await mkdtemp(join(tmpdir(), "flowmate-desktop-"));
  application = await electron.launch({ args: [main, `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_IS_DEV: "0", FLOWMATE_DESKTOP_CONFIG: "" } });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterEach(async () => {
  await application?.close();
  if (userData) await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test("opens the P0 surface with a restricted renderer boundary", async () => {
  await expect(page.getByRole("heading", { name: "发票字段抽取" })).toBeVisible();
  await expect(page.getByText("真实 Pi Runtime · 受控输入 · 可追溯候选")).toBeVisible();
  await expect(page.locator("button", { hasText: "开始抽取" })).toBeDisabled();
  expect(await page.evaluate(() => typeof window.flowmate?.getDiagnostics)).toBe("function");
  expect(await page.evaluate(() => window.flowmate.getDiagnostics())).toMatchObject({ profileId: "unavailable" });
  await expect(page.locator(".notice.error")).toHaveCount(0);
  expect(await page.evaluate(() => ({ hasRequire: "require" in globalThis, hasProcess: "process" in globalThis }))).toEqual({ hasRequire: false, hasProcess: false });
});
