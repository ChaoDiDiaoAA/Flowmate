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
      throw new Error("OpenCLI registry discovery failed");
    }

    this.registry = parseJsonArray(result.stdout, "OpenCLI registry").map(
      validateRegistryDescriptor,
    );
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
      status: result.exitCode === 0 ? "succeeded" : "failed",
      exitCode: result.exitCode,
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

function validateRegistryDescriptor(
  value: unknown,
  index: number,
): OpenCliCommandDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OpenCLI registry entry ${index + 1} must be an object`);
  }

  const descriptor = value as Record<string, unknown>;
  requiredString(descriptor, "command", index);
  requiredString(descriptor, "site", index);
  requiredString(descriptor, "name", index);
  requiredAccess(descriptor, index);
  requiredString(descriptor, "strategy", index);
  requiredBoolean(descriptor, "browser", index);
  return value as OpenCliCommandDescriptor;
}

function requiredString(
  descriptor: Record<string, unknown>,
  field: string,
  index: number,
): string {
  const value = descriptor[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`OpenCLI registry entry ${index + 1} has invalid ${field}`);
  }
  return value;
}

function requiredAccess(
  descriptor: Record<string, unknown>,
  index: number,
): "read" | "write" {
  const value = descriptor.access;
  if (value !== "read" && value !== "write") {
    throw new Error(`OpenCLI registry entry ${index + 1} has invalid access`);
  }
  return value;
}

function requiredBoolean(
  descriptor: Record<string, unknown>,
  field: string,
  index: number,
): boolean {
  const value = descriptor[field];
  if (typeof value !== "boolean") {
    throw new Error(`OpenCLI registry entry ${index + 1} has invalid ${field}`);
  }
  return value;
}

function traceReference(stderr: string): { traceRef?: string } {
  const match = /trace:\s*(.+)/i.exec(stderr);
  const traceRef = match?.[1]?.trim();
  return traceRef ? { traceRef } : {};
}
