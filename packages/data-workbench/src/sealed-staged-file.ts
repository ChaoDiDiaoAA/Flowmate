import { createHash } from "node:crypto";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export class SealedStagedFile {
  private constructor(
    private readonly handle: FileHandle,
    public readonly jobId: string,
    public readonly fileName: string,
    private readonly cleanupDirectory: string,
  ) {}

  public static async create(jobId: string, fileName: string): Promise<{
    targetFile: string;
    seal: () => Promise<SealedStagedFile>;
  }> {
    const cleanupDirectory = await mkdtemp(path.join(os.tmpdir(), "flowmate-public-download-"));
    const targetFile = path.join(cleanupDirectory, fileName);
    return {
      targetFile,
      seal: async () => new SealedStagedFile(await open(targetFile, "r"), jobId, fileName, cleanupDirectory),
    };
  }

  public async sha256(): Promise<string> {
    const hash = createHash("sha256");
    await this.readChunks(async (chunk) => {
      hash.update(chunk);
    });
    return hash.digest("hex");
  }

  public async copyTo(destination: string): Promise<void> {
    const output = await open(destination, "wx");
    try {
      await this.readChunks(async (chunk, position) => {
        await output.write(chunk, 0, chunk.length, position);
      });
    } finally {
      await output.close();
    }
  }

  public async dispose(): Promise<void> {
    await this.handle.close();
    await rm(this.cleanupDirectory, { recursive: true, force: true });
  }

  private async readChunks(consume: (chunk: Buffer, position: number) => Promise<void>): Promise<void> {
    const size = (await this.handle.stat()).size;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (let position = 0; position < size;) {
      const { bytesRead } = await this.handle.read(buffer, 0, Math.min(buffer.length, size - position), position);
      if (bytesRead === 0) {
        throw new Error("Sealed staged file ended before its recorded size");
      }
      await consume(Buffer.from(buffer.subarray(0, bytesRead)), position);
      position += bytesRead;
    }
  }
}
