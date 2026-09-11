import { test, expect } from "@playwright/test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";

let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  const main = resolve(process.cwd(), "out/main/index.js");
  await access(main, constants.R_OK);
  const electronBinary = resolve(process.cwd(), "node_modules/electron", process.platform === "win32" ? "dist/electron.exe" : "dist/electron");
  try {
    await access(electronBinary, constants.X_OK);
  } catch {
    test.skip(true, "Electron binary is not installed; run npm install with Electron download enabled");
  }
  application = await electron.launch({ args: [main], env: { ...process.env, ELECTRON_IS_DEV: "0" } });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterEach(async () => {
  await application?.close();
});

test("opens the P0 surface with a restricted renderer boundary", async () => {
  await expect(page.getByRole("heading", { name: "发票字段抽取" })).toBeVisible();
  await expect(page.getByText("真实 Pi Runtime · 受控输入 · 可追溯候选")).toBeVisible();
  await expect(page.locator("button", { hasText: "开始抽取" })).toBeDisabled();
  expect(await page.evaluate(() => ({ hasRequire: "require" in globalThis, hasProcess: "process" in globalThis }))).toEqual({ hasRequire: false, hasProcess: false });
});
