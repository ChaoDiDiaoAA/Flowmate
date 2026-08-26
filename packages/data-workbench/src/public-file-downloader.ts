import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ProcessRunner } from "./process-runner.js";
import { resolveContainedStagingFile } from "./staging-containment.js";

export interface PublicFileDownloader {
  download(input: {
    url: string;
    allowedDomain: string;
    targetFile: string;
  }): Promise<{ fileRef: string; rawSha256: string }>;
}

export class PowerShellPublicFileDownloader implements PublicFileDownloader {
  public constructor(
    private readonly runner: ProcessRunner,
    private readonly stagingDirectory: string,
    private readonly scriptPath = path.resolve(process.cwd(), "scripts", "download-public-file.ps1"),
  ) {}

  public async download(input: {
    url: string;
    allowedDomain: string;
    targetFile: string;
  }): Promise<{ fileRef: string; rawSha256: string }> {
    const url = validatePublicUrl(input.url, input.allowedDomain);
    const targetFile = await resolveContainedStagingFile(
      path.dirname(this.stagingDirectory),
      path.basename(this.stagingDirectory),
      input.targetFile,
    );
    if (await fileExists(targetFile)) {
      return { fileRef: targetFile, rawSha256: await sha256File(targetFile) };
    }

    const result = await this.runner.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      this.scriptPath,
      "-Url",
      input.url,
      "-TargetFile",
      targetFile,
    ]);
    if (result.exitCode !== 0 || !(await fileExists(targetFile))) {
      throw new Error(`Public file download failed: ${safeUrl(url)}`);
    }
    return { fileRef: targetFile, rawSha256: await sha256File(targetFile) };
  }
}

function validatePublicUrl(value: string, allowedDomain: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Public file URL is invalid");
  }
  if (url.protocol !== "https:") {
    throw new Error("Public file URL must use HTTPS");
  }
  if (url.hostname.toLowerCase() !== allowedDomain.toLowerCase()) {
    throw new Error("Public file URL domain does not match the allowed domain");
  }
  return url;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function safeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
