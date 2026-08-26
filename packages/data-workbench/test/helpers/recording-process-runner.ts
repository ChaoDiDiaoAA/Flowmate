import type { ProcessResult, ProcessRunner } from "../../src/process-runner.js";

export class RecordingProcessRunner implements ProcessRunner {
  readonly responses: ProcessResult[];
  callCount = 0;
  lastCommand?: string;
  lastArgs?: string[];

  constructor(response: ProcessResult | ProcessResult[]) {
    this.responses = Array.isArray(response) ? response : [response];
  }

  async run(command: string, args: string[]): Promise<ProcessResult> {
    this.callCount += 1;
    this.lastCommand = command;
    this.lastArgs = args;
    const response = this.responses[this.callCount - 1];
    if (!response) {
      throw new Error("No recorded process response available");
    }
    return response;
  }
}
