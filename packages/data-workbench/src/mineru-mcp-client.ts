import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROJECT_WRAPPER_PATH = "D:\\code\\agent-learn\\agent\\Flowmate\\tools\\mineru-mcp-wrapper";

export interface MineruMcpTransport {
  connect(): Promise<void>;
  callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface MineruMcpClientConfig {
  maxFilesPerRun: number;
}

export interface MineruParsedFile {
  filename: string;
  content: string;
  contentChars: number;
  truncated: boolean;
  warnings: string[];
}

interface MineruToolResult {
  filename: string;
  status: string;
  content?: string;
  content_chars?: number;
  truncated?: boolean;
  error?: string;
}

interface MineruToolResponse {
  status: string;
  results: MineruToolResult[];
  summary: {
    total_files: number;
    success_count: number;
    error_count: number;
  };
  message: string;
}

export class MineruResultDownloadTlsError extends Error {
  public constructor() {
    super("RESULT_DOWNLOAD_TLS_FAILED");
    this.name = "MineruResultDownloadTlsError";
  }
}

/** Starts the project-scoped safety wrapper; it never reads process secrets. */
export class ProjectMineruMcpTransport implements MineruMcpTransport {
  private readonly client = new Client({ name: "flowmate-data-workbench", version: "0.1.0" });
  private readonly transport = new StdioClientTransport({
    command: "uv",
    args: ["run", "--project", PROJECT_WRAPPER_PATH, "flowmate-mineru-mcp"],
    // Upstream dependencies can include signed URLs in diagnostic logs. MCP
    // protocol data travels over stdout, so server stderr is never needed.
    stderr: "ignore",
  });

  public async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  public async callTool(name: string, arguments_: Record<string, unknown>): Promise<unknown> {
    return this.client.callTool({ name, arguments: arguments_ });
  }

  public async close(): Promise<void> {
    await this.client.close();
  }
}

export class MineruMcpClient {
  private connected = false;

  public constructor(
    private readonly transport: MineruMcpTransport,
    private readonly config: MineruMcpClientConfig,
  ) {
    if (!Number.isInteger(config.maxFilesPerRun) || config.maxFilesPerRun < 1 || config.maxFilesPerRun > 200) {
      throw new Error("MinerU maximum files per run must be between 1 and 200");
    }
  }

  public static usingProjectWrapper(config: MineruMcpClientConfig): MineruMcpClient {
    return new MineruMcpClient(new ProjectMineruMcpTransport(), config);
  }

  public async parseDocuments(fileSources: readonly string[]): Promise<MineruParsedFile[]> {
    if (fileSources.length > this.config.maxFilesPerRun) {
      throw new Error(`MinerU maximum is ${this.config.maxFilesPerRun} files per run`);
    }
    if (fileSources.length === 0) {
      throw new Error("MinerU requires at least one local file");
    }
    if (!this.connected) {
      await this.transport.connect();
      this.connected = true;
    }
    const response = parseToolResponse(await this.transport.callTool("parse_documents", { file_sources: [...fileSources] }));
    if (response.message.includes("RESULT_DOWNLOAD_TLS_FAILED")) {
      throw new MineruResultDownloadTlsError();
    }
    const failures = response.results.filter((result) => result.status !== "success");
    const warnings = failures.map((result) => `${result.filename}: ${result.error ?? result.status}`);
    const successful = response.results
      .filter((result) => result.status === "success")
      .map((result): MineruParsedFile => ({
        filename: result.filename,
        content: result.content ?? "",
        contentChars: result.content_chars ?? (result.content?.length ?? 0),
        truncated: result.truncated ?? false,
        warnings,
      }));
    if (successful.length === 0 || successful.some((result) => result.content.length === 0)) {
      throw new Error("MinerU returned empty parse output");
    }
    return successful;
  }

  public async close(): Promise<void> {
    if (this.connected) {
      await this.transport.close();
      this.connected = false;
    }
  }
}

function parseToolResponse(value: unknown): MineruToolResponse {
  const candidate = unwrapToolResponse(value);
  if (!isMineruToolResponse(candidate)) {
    throw new Error("MinerU returned an invalid parse response");
  }
  return candidate;
}

function unwrapToolResponse(value: unknown): unknown {
  if (isRecord(value) && "structuredContent" in value) {
    return value.structuredContent;
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    const text = value.content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
    if (text && typeof text.text === "string") {
      try {
        return JSON.parse(text.text) as unknown;
      } catch {
        throw new Error("MinerU returned invalid JSON text");
      }
    }
  }
  return value;
}

function isMineruToolResponse(value: unknown): value is MineruToolResponse {
  return isRecord(value) && typeof value.status === "string" && Array.isArray(value.results) &&
    isRecord(value.summary) && typeof value.summary.total_files === "number" &&
    typeof value.summary.success_count === "number" && typeof value.summary.error_count === "number" &&
    typeof value.message === "string" && value.results.every(isMineruToolResult);
}

function isMineruToolResult(value: unknown): value is MineruToolResult {
  return isRecord(value) && typeof value.filename === "string" && typeof value.status === "string" &&
    (value.content === undefined || typeof value.content === "string") &&
    (value.content_chars === undefined || typeof value.content_chars === "number") &&
    (value.truncated === undefined || typeof value.truncated === "boolean") &&
    (value.error === undefined || typeof value.error === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
