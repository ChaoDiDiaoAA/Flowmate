import type { AcquisitionResult, OpenCliCommandDescriptor } from "./types.js";
import type { ProcessRunner } from "./process-runner.js";

export interface OpenCliAcquisitionRequest {
  sourceId: string;
  site: string;
  command: string;
  args: string[];
}

export class OpenCliGateway {
  private registry: OpenCliCommandDescriptor[] | undefined;

  constructor(
    private readonly runner: ProcessRunner,
    registry?: OpenCliCommandDescriptor[],
  ) {
    this.registry = registry;
  }

  async discover(): Promise<OpenCliCommandDescriptor[]> {
    const result = await this.runner.run("opencli", ["list", "-f", "json"]);
    if (result.exitCode !== 0) {
      throw new Error(`OpenCLI registry discovery failed: ${result.stderr.trim()}`);
    }

    const registry = parseJsonArray(result.stdout, "OpenCLI registry");
    this.registry = registry as OpenCliCommandDescriptor[];
    return this.registry;
  }

  async runPublic(request: OpenCliAcquisitionRequest): Promise<AcquisitionResult> {
    const registry = this.registry ?? await this.discover();
    const adapterRef = `${request.site}/${request.command}`;
    const descriptor = registry.find(({ command }) => command === adapterRef);
    if (!descriptor) {
      throw new Error(`OpenCLI command not found: ${adapterRef}`);
    }
    if (descriptor.strategy !== "public" || descriptor.access !== "read") {
      throw new Error(`OpenCLI command must be PUBLIC read: ${adapterRef}`);
    }

    const result = await this.runner.run("opencli", [
      request.site,
      request.command,
      ...request.args,
      "-f",
      "json",
      "--trace",
      "retain-on-failure",
    ]);

    return {
      jobId: request.sourceId,
      adapterRef,
      strategy: "public",
      retrievedAt: new Date().toISOString(),
      items: result.exitCode === 0
        ? parseJsonArray(result.stdout, `OpenCLI command ${adapterRef}`)
        : [],
      ...traceReference(result.stderr),
    };
  }
}

function parseJsonArray(value: string, label: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error("expected a JSON array");
    }
    return parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} did not return JSON array: ${reason}`, { cause: error });
  }
}

function traceReference(stderr: string): { traceRef?: string } {
  const match = /trace:\s*(.+)/i.exec(stderr);
  const traceRef = match?.[1]?.trim();
  return traceRef ? { traceRef } : {};
}
