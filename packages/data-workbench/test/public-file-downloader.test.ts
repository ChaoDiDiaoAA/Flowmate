import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProcessResult, ProcessRunner } from "../src/process-runner.js";
import { PowerShellPublicFileDownloader } from "../src/public-file-downloader.js";

const temporaryRoots: string[] = [];

class DownloadingProcessRunner implements ProcessRunner {
  calls: Array<{ command: string; args: string[] }> = [];
  constructor(private readonly exitCode = 0) {}

  async run(command: string, args: string[]): Promise<ProcessResult> {
    this.calls.push({ command, args });
    if (this.exitCode === 0) {
      const targetFile = args[args.indexOf("-TargetFile") + 1];
      if (!targetFile) {
        throw new Error("Target file argument missing");
      }
      await writeFile(`${targetFile}.download`, "downloaded body", "utf8");
      await rename(`${targetFile}.download`, targetFile);
    }
    return { exitCode: this.exitCode, stdout: "", stderr: "signed-url?token=secret" };
  }
}

async function createDownloader(exitCode = 0): Promise<{
  root: string;
  staging: string;
  runner: DownloadingProcessRunner;
  downloader: PowerShellPublicFileDownloader;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-downloader-"));
  temporaryRoots.push(root);
  const staging = path.join(root, "staging", "ACQ-20260826-0001");
  await mkdir(staging, { recursive: true });
  const runner = new DownloadingProcessRunner(exitCode);
  return {
    root,
    staging,
    runner,
    downloader: new PowerShellPublicFileDownloader(runner, staging, "C:\\scripts\\download-public-file.ps1"),
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("PowerShellPublicFileDownloader", () => {
  it("only accepts HTTPS URLs on the exact policy domain", async () => {
    const { staging, downloader, runner } = await createDownloader();
    const target = path.join(staging, "invoice.pdf");

    await expect(downloader.download({
      url: "http://example.com/invoice.pdf",
      allowedDomain: "example.com",
      targetFile: target,
    })).rejects.toThrow(/https/i);
    await expect(downloader.download({
      url: "https://sub.example.com/invoice.pdf",
      allowedDomain: "example.com",
      targetFile: target,
    })).rejects.toThrow(/allowed domain/i);
    expect(runner.calls).toEqual([]);
  });

  it("runs the PowerShell downloader as a shell-free argv invocation inside job staging", async () => {
    const { staging, downloader, runner } = await createDownloader();
    const target = path.join(staging, "invoice.pdf");

    const download = await downloader.download({
      url: "https://example.com/invoice.pdf?signature=secret",
      allowedDomain: "example.com",
      targetFile: target,
    });

    expect(runner.calls).toEqual([{
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        "C:\\scripts\\download-public-file.ps1",
        "-Url",
        "https://example.com/invoice.pdf?signature=secret",
        "-TargetFile",
        target,
      ],
    }]);
    expect(download.fileRef).toBe(target);
    await expect(readFile(download.fileRef, "utf8")).resolves.toBe("downloaded body");
  });

  it("rejects targets outside the current job staging directory before spawning", async () => {
    const { root, downloader, runner } = await createDownloader();

    await expect(downloader.download({
      url: "https://example.com/invoice.pdf",
      allowedDomain: "example.com",
      targetFile: path.join(root, "outside.pdf"),
    })).rejects.toThrow(/staging/i);
    expect(runner.calls).toEqual([]);
  });

  it("does not disclose signed URL queries when PowerShell fails", async () => {
    const { staging, downloader } = await createDownloader(1);

    await expect(downloader.download({
      url: "https://example.com/invoice.pdf?token=secret",
      allowedDomain: "example.com",
      targetFile: path.join(staging, "invoice.pdf"),
    })).rejects.toThrow("Public file download failed: https://example.com/invoice.pdf");
  });

  it("does not invoke PowerShell again when the target is already a complete file", async () => {
    const { staging, downloader, runner } = await createDownloader();
    const target = path.join(staging, "invoice.pdf");
    await writeFile(target, "already present", "utf8");

    const download = await downloader.download({
      url: "https://example.com/invoice.pdf",
      allowedDomain: "example.com",
      targetFile: target,
    });

    expect(runner.calls).toEqual([]);
    expect(download.rawSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
