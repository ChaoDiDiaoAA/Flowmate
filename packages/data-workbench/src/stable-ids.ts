const sourceIdPattern = /^SRC-\d{6}$/;
const acquisitionJobIdPattern = /^ACQ-\d{8}-\d{4}$/;

export function assertSourceId(sourceId: string): string {
  if (!sourceIdPattern.test(sourceId)) {
    throw new Error(`Invalid source ID: ${sourceId}`);
  }
  return sourceId;
}

export function assertAcquisitionJobId(jobId: string): string {
  if (!acquisitionJobIdPattern.test(jobId)) {
    throw new Error(`Invalid acquisition job ID: ${jobId}`);
  }
  return jobId;
}
