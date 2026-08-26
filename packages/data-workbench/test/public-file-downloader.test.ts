import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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

class ReplacingParentProcessRunner extends DownloadingProcessRunner {
  constructor(private readonly staging: string, private readonly outside: string) {
    super();
  }

  override async run(command: string, args: string[]): Promise<ProcessResult> {
    const movedStaging = `${this.staging}.moved`;
    await rename(this.staging, movedStaging);
    await symlink(this.outside, this.staging, process.platform === "win32" ? "junction" : "dir");
    return super.run(command, args);
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

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.command).toBe("powershell.exe");
    expect(runner.calls[0]?.args.slice(0, -1)).toEqual(["-NoProfile", "-NonInteractive", "-File", "C:\\scripts\\download-public-file.ps1", "-Url", "https://example.com/invoice.pdf?signature=secret", "-TargetFile"]);
    expect(runner.calls[0]?.args.at(-1)).not.toBe(target);
    expect(download.fileRef.fileName).toBe("invoice.pdf");
    expect(download.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    await download.fileRef.dispose();
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

  it("rejects an existing target reached through a staging reparse point before spawning", async () => {
    const { root, staging, downloader, runner } = await createDownloader();
    const outside = path.join(root, "outside");
    const reparsePoint = path.join(staging, "escape");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "invoice.pdf"), "outside staging", "utf8");
    await symlink(outside, reparsePoint, process.platform === "win32" ? "junction" : "dir");

    await expect(downloader.download({
      url: "https://example.com/invoice.pdf",
      allowedDomain: "example.com",
      targetFile: path.join(reparsePoint, "invoice.pdf"),
    })).rejects.toThrow(/reparse|staging/i);
    expect(runner.calls).toEqual([]);
  });

  it("keeps an outside replacement parent untouched when it changes after validation", async () => {
    const { root, staging } = await createDownloader();
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "invoice.pdf"), "outside sentinel", "utf8");
    const runner = new ReplacingParentProcessRunner(staging, outside);
    const downloader = new PowerShellPublicFileDownloader(runner, staging, "C:\\scripts\\download-public-file.ps1");

    const download = await downloader.download({
      url: "https://example.com/invoice.pdf",
      allowedDomain: "example.com",
      targetFile: path.join(staging, "invoice.pdf"),
    });

    await expect(readFile(path.join(outside, "invoice.pdf"), "utf8")).resolves.toBe("outside sentinel");
    await download.fileRef.dispose();
  });

  it("does not disclose signed URL queries when PowerShell fails", async () => {
    const { staging, downloader } = await createDownloader(1);

    await expect(downloader.download({
      url: "https://example.com/invoice.pdf?token=secret",
      allowedDomain: "example.com",
      targetFile: path.join(staging, "invoice.pdf"),
    })).rejects.toThrow("Public file download failed: https://example.com/invoice.pdf");
  });

  it("does not trust a pre-existing staging target as a downloadable body", async () => {
    const { staging, downloader, runner } = await createDownloader();
    const target = path.join(staging, "invoice.pdf");
    await writeFile(target, "already present", "utf8");

    const download = await downloader.download({
      url: "https://example.com/invoice.pdf",
      allowedDomain: "example.com",
      targetFile: target,
    });

    expect(runner.calls).toHaveLength(1);
    expect(download.rawSha256).toMatch(/^[a-f0-9]{64}$/);
    await download.fileRef.dispose();
  });
});
