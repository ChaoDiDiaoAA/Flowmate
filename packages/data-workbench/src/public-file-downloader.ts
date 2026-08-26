import path from "node:path";
import type { ProcessRunner } from "./process-runner.js";
import { resolveContainedStagingFile } from "./staging-containment.js";
import { SealedStagedFile } from "./sealed-staged-file.js";

export interface PublicFileDownloader {
  download(input: {
    url: string;
    allowedDomain: string;
    targetFile: string;
  }): Promise<{ fileRef: SealedStagedFile; rawSha256: string }>;
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
  }): Promise<{ fileRef: SealedStagedFile; rawSha256: string }> {
    const url = validatePublicUrl(input.url, input.allowedDomain);
    const targetFile = await resolveContainedStagingFile(
      path.dirname(this.stagingDirectory),
      path.basename(this.stagingDirectory),
      input.targetFile,
    );
    const privateDownload = await SealedStagedFile.create(path.basename(this.stagingDirectory), path.basename(targetFile));

    const result = await this.runner.run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      this.scriptPath,
      "-Url",
      input.url,
      "-TargetFile",
      privateDownload.targetFile,
    ]);
    if (result.exitCode !== 0) {
      throw new Error(`Public file download failed: ${safeUrl(url)}`);
    }
    let fileRef: SealedStagedFile;
    try {
      fileRef = await privateDownload.seal();
    } catch {
      throw new Error(`Public file download failed: ${safeUrl(url)}`);
    }
    return { fileRef, rawSha256: await fileRef.sha256() };
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

function safeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
