import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(command: string, args: string[]): Promise<ProcessResult>;
}

export class SpawnProcessRunner implements ProcessRunner {
  run(command: string, args: string[]): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const invocation = resolveInvocation(command, args);
      const child = spawn(invocation.command, invocation.args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", reject);
      child.once("close", (exitCode) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });
    });
  }
}

function resolveInvocation(command: string, args: string[]): {
  command: string;
  args: string[];
} {
  if (process.platform !== "win32") {
    return { command, args };
  }

  const scriptPath = findPowerShellScript(command);
  if (!scriptPath) {
    return { command, args };
  }

  return {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-File", scriptPath, ...args],
  };
}

function findPowerShellScript(command: string): string | undefined {
  const pathEntries = process.env.PATH?.split(path.delimiter) ?? [];
  for (const entry of pathEntries) {
    const candidate = path.join(entry, `${command}.ps1`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
