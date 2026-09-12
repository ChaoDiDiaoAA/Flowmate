import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Application } from "./composition.js";
import { IPC_CHANNELS, registerIpcHandlers } from "./ipc.js";
import { shutdownApplication } from "./shutdown.js";
import { loadDesktopApplication } from "./startup.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let currentApplication: Application | undefined;
let unregisterIpc: (() => void) | undefined;
let quitting = false;
let closing: Promise<void> | undefined;

function unavailableApplication(): Application {
  const unavailable = async (): Promise<never> => { throw new Error("DESKTOP_NOT_READY"); };
  return {
    listSamples: () => [],
    start: unavailable,
    rebuild: unavailable,
    cancel: unavailable,
    wait: unavailable,
    getJob: unavailable,
    getEvidence: unavailable,
    getDiagnostics: () => ({ activeRunCount: 0, datasetVersion: "unavailable", candidateId: "unavailable", profileId: "unavailable" }),
    close: async () => {},
  } as unknown as Application;
}

export async function createMainWindow(application?: Application): Promise<BrowserWindow> {
  currentApplication = application ?? unavailableApplication();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      preload: join(currentDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  unregisterIpc = registerIpcHandlers(mainWindow, currentApplication);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault();
  });
  mainWindow.on("close", (event) => {
    event.preventDefault();
    void closeMainWindow().catch(reportStartupError);
  });
  mainWindow.on("closed", () => { unregisterIpc?.(); unregisterIpc = undefined; mainWindow = undefined; });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(join(currentDir, "../renderer/index.html"));
  return mainWindow;
}

export async function closeMainWindow(): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    const result = await shutdownApplication(currentApplication);
    if (result.status === "incomplete") throw new Error(`DESKTOP_CLEANUP_INCOMPLETE: ${result.reason}`);
    currentApplication = undefined;
    mainWindow?.destroy();
  })();
  try { await closing; } finally { closing = undefined; }
}

export async function bootstrap(applicationFactory?: () => Promise<Application>): Promise<void> {
  await app.whenReady();
  const configuredFactory = applicationFactory ?? (process.env.FLOWMATE_DESKTOP_CONFIG
    ? () => loadDesktopApplication(process.env.FLOWMATE_DESKTOP_CONFIG!) : undefined);
  app.on("activate", () => {
    if (!mainWindow && !closing) void (async () => createMainWindow(configuredFactory ? await configuredFactory() : undefined))().catch(reportStartupError);
  });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void closeMainWindow().then(() => app.quit()).catch((error: unknown) => { quitting = false; reportStartupError(error); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  const application = configuredFactory ? await configuredFactory() : undefined;
  await createMainWindow(application);
}

function reportStartupError(error: unknown): void {
  console.error("Flowmate desktop failed:", error instanceof Error ? error.message : "unknown error");
}

const entryFile = fileURLToPath(import.meta.url);
const invokedWithEntryFile = process.argv.slice(1).some((argument) => {
  try {
    return fileURLToPath(pathToFileURL(argument)) === entryFile;
  } catch {
    return false;
  }
});

if (invokedWithEntryFile) {
  void bootstrap().catch(async (error: unknown) => {
    reportStartupError(error);
    await shutdownApplication(currentApplication);
    app.exit(1);
  });
}

export { IPC_CHANNELS };
