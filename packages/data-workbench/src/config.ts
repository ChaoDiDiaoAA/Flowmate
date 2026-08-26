import path from "node:path";

export interface DataWorkbenchConfig {
  dataRoot: string;
  mineruMaxFilesPerRun: number;
}

export function resolveConfig(
  env: Record<string, string | undefined>,
): DataWorkbenchConfig {
  const dataRoot = path.win32.normalize(
    env.FLOWMATE_DATA_ROOT ?? "D:\\code\\agent-learn\\agent\\Flowmate\\FlowmateData",
  );
  const mineruMaxFilesPerRun = Number(
    env.FLOWMATE_MINERU_MAX_FILES_PER_RUN ?? "200",
  );
  if (
    !Number.isInteger(mineruMaxFilesPerRun) ||
    mineruMaxFilesPerRun < 1 ||
    mineruMaxFilesPerRun > 200
  ) {
    throw new Error(
      "FLOWMATE_MINERU_MAX_FILES_PER_RUN must be between 1 and 200",
    );
  }
  return { dataRoot, mineruMaxFilesPerRun };
}
