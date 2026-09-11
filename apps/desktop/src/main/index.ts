import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Application } from "./composition.js";
import { IPC_CHANNELS, registerIpcHandlers } from "./ipc.js";
import { shutdownApplication } from "./shutdown.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | undefined;
let currentApplication: Application | undefined;
let unregisterIpc: (() => void) | undefined;
let quitting = false;

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
      preload: join(currentDir, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  unregisterIpc = registerIpcHandlers(mainWindow, currentApplication);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = url.startsWith("file://") || url.startsWith("http://localhost");
    if (!allowed) event.preventDefault();
  });
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) await mainWindow.loadURL(rendererUrl);
  else await mainWindow.loadFile(join(currentDir, "../renderer/index.html"));
  mainWindow.on("closed", () => { unregisterIpc?.(); unregisterIpc = undefined; mainWindow = undefined; });
  return mainWindow;
}

export async function closeMainWindow(): Promise<void> {
  if (!mainWindow) return;
  await shutdownApplication(currentApplication);
  mainWindow.destroy();
  currentApplication = undefined;
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  await createMainWindow();
  app.on("activate", () => { if (!mainWindow) void createMainWindow(currentApplication); });
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void closeMainWindow().finally(() => app.quit());
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void bootstrap();
}

export { IPC_CHANNELS };
