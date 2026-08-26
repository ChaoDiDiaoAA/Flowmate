import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export async function resolveContainedStagingFile(
  stagingRoot: string,
  jobId: string,
  filePath: string,
): Promise<string> {
  const jobDirectory = path.resolve(stagingRoot, jobId);
  const resolvedFile = path.resolve(filePath);
  assertLexicallyContained(jobDirectory, resolvedFile);
  await assertNoStagingReparsePoint(jobDirectory, resolvedFile);

  const realJobDirectory = await realpath(jobDirectory);
  const realParentDirectory = await realpath(path.dirname(resolvedFile));
  assertContainedDirectory(realJobDirectory, realParentDirectory);

  const target = await tryLstat(resolvedFile);
  if (target?.isSymbolicLink()) {
    throw new Error("Staged file cannot be a symbolic link or reparse point");
  }
  if (target) {
    const realFile = await realpath(resolvedFile);
    assertLexicallyContained(realJobDirectory, realFile);
  }
  return resolvedFile;
}

function assertLexicallyContained(directory: string, filePath: string): void {
  const relative = path.relative(directory, filePath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Staged file must be inside the current acquisition job staging directory");
  }
}

function assertContainedDirectory(directory: string, candidate: string): void {
  const relative = path.relative(directory, candidate);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Staged file must be inside the current acquisition job staging directory");
  }
}

async function assertNoStagingReparsePoint(jobDirectory: string, filePath: string): Promise<void> {
  const jobDirectoryStats = await tryLstat(jobDirectory);
  if (!jobDirectoryStats?.isDirectory() || jobDirectoryStats.isSymbolicLink()) {
    throw new Error("Current acquisition job staging directory must be a real directory");
  }

  const relative = path.relative(jobDirectory, filePath);
  const segments = relative.split(path.sep);
  let current = jobDirectory;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = await tryLstat(current);
    if (!stats) {
      if (index !== segments.length - 1) {
        throw new Error("Staged file parent directory must already exist");
      }
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new Error("Staged file cannot cross a symbolic link or reparse point");
    }
    if (index !== segments.length - 1 && !stats.isDirectory()) {
      throw new Error("Staged file parent must be a directory");
    }
  }
}

async function tryLstat(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error: unknown) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
