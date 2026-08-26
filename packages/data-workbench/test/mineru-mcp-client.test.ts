import { describe, expect, it } from "vitest";
import {
  MineruMcpClient,
  MineruResultDownloadTlsError,
  type MineruMcpTransport,
} from "../src/mineru-mcp-client.js";

class RecordingMcpTransport implements MineruMcpTransport {
  public callCount = 0;
  public connectCount = 0;

  public constructor(private readonly response: unknown = successResponse()) {}

  public async connect(): Promise<void> {
    this.connectCount += 1;
  }

  public async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    this.callCount += 1;
    expect(name).toBe("parse_documents");
    expect(arguments_).toEqual({ file_sources: ["dummy.pdf"] });
    return this.response;
  }

  public async close(): Promise<void> {}
}

function successResponse(): unknown {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "success",
        results: [{
          filename: "dummy.pdf",
          status: "success",
          content: "Dummy PDF file",
          content_chars: 14,
          truncated: false,
        }],
        summary: { total_files: 1, success_count: 1, error_count: 0 },
        message: "Parsing complete!\n",
      }),
    }],
  };
}

describe("MineruMcpClient", () => {
  it("rejects 201 files before connecting to MinerU", async () => {
    const transport = new RecordingMcpTransport();
    const client = new MineruMcpClient(transport, { maxFilesPerRun: 200 });
    const sources = Array.from({ length: 201 }, (_, index) => `document-${index}.pdf`);

    await expect(client.parseDocuments(sources)).rejects.toThrow(/maximum.*200/i);
    expect(transport.connectCount).toBe(0);
    expect(transport.callCount).toBe(0);
  });

  it("parses the complete success response returned by the MinerU MCP tool", async () => {
    const transport = new RecordingMcpTransport();
    const client = new MineruMcpClient(transport, { maxFilesPerRun: 200 });

    await expect(client.parseDocuments(["dummy.pdf"])).resolves.toEqual([{
      filename: "dummy.pdf",
      content: "Dummy PDF file",
      contentChars: 14,
      truncated: false,
      warnings: [],
    }]);
  });

  it("keeps successful files and exposes failed files as warnings from a partial response", async () => {
    const response = {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "partial_success",
          results: [
            { filename: "ok.pdf", status: "success", content: "ok", content_chars: 2, truncated: false },
            { filename: "bad.pdf", status: "error", error: "encrypted PDF" },
          ],
          summary: { total_files: 2, success_count: 1, error_count: 1 },
          message: "Parsing partially complete!\n",
        }),
      }],
    };
    const client = new MineruMcpClient(new RecordingMcpTransport(response), { maxFilesPerRun: 200 });

    await expect(client.parseDocuments(["dummy.pdf"])).resolves.toEqual([{
      filename: "ok.pdf",
      content: "ok",
      contentChars: 2,
      truncated: false,
      warnings: ["bad.pdf: encrypted PDF"],
    }]);
  });

  it("classifies the wrapper TLS result-download failure without leaking transport details", async () => {
    const response = {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "error",
          results: [],
          summary: { total_files: 1, success_count: 0, error_count: 1 },
          message: "RESULT_DOWNLOAD_TLS_FAILED: result download failed",
        }),
      }],
    };
    const client = new MineruMcpClient(new RecordingMcpTransport(response), { maxFilesPerRun: 200 });

    await expect(client.parseDocuments(["dummy.pdf"])).rejects.toBeInstanceOf(MineruResultDownloadTlsError);
  });

  it("rejects an MCP success response that has no parseable output", async () => {
    const response = {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: "success",
          results: [],
          summary: { total_files: 1, success_count: 1, error_count: 0 },
          message: "Parsing complete!\n",
        }),
      }],
    };
    const client = new MineruMcpClient(new RecordingMcpTransport(response), { maxFilesPerRun: 200 });

    await expect(client.parseDocuments(["dummy.pdf"])).rejects.toThrow(/empty/i);
  });
});
