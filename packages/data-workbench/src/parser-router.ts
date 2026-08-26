import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MineruMcpClient } from "./mineru-mcp-client.js";
import type { DocumentParser, ParsedDocument, ParseDocumentInput } from "./types.js";

interface DerivedParser extends DocumentParser {
  readonly parserVersion: string;
}

interface DerivedOutput {
  content: string;
  structure: unknown;
  warnings: string[];
  pageCount?: number;
}

export class NativeTextParser implements DerivedParser {
  public readonly name = "native-text";
  public readonly parserVersion = "native-text-v1";

  public constructor(private readonly derivedRoot: string) {}

  public async parse(input: ParseDocumentInput): Promise<ParsedDocument> {
    const content = await readSealedText(input);
    return writeDerivedOutput(this.derivedRoot, this, input, {
      content,
      structure: { type: "text", lineCount: content.split(/\r?\n/).filter(Boolean).length },
      warnings: [],
    });
  }
}

export class HtmlContentParser implements DerivedParser {
  public readonly name = "html";
  public readonly parserVersion = "html-v1";

  public constructor(private readonly derivedRoot: string) {}

  public async parse(input: ParseDocumentInput): Promise<ParsedDocument> {
    const content = htmlToText(await readSealedText(input));
    return writeDerivedOutput(this.derivedRoot, this, input, {
      content,
      structure: { type: "html", extractedText: true },
      warnings: [],
    });
  }
}

export class MineruDocumentParser implements DerivedParser {
  public readonly name = "mineru";
  public readonly parserVersion = "mineru-open-mcp-1.0.21";

  public constructor(
    private readonly client: MineruMcpClient,
    private readonly derivedRoot: string,
  ) {}

  public async parse(input: ParseDocumentInput): Promise<ParsedDocument> {
    const workDirectory = await mkdtemp(path.join(os.tmpdir(), "flowmate-mineru-input-"));
    const localFile = path.join(workDirectory, input.sourceFile.fileName);
    try {
      await input.sourceFile.copyTo(localFile);
      const result = (await this.client.parseDocuments([localFile]))[0];
      if (!result) {
        throw new Error("MinerU returned no output for the requested artifact");
      }
      return writeDerivedOutput(this.derivedRoot, this, input, {
        content: result.content,
        structure: {
          type: "mineru",
          filename: result.filename,
          contentChars: result.contentChars,
          truncated: result.truncated,
        },
        warnings: result.warnings,
      });
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}

class UnavailableMineruParser implements DocumentParser {
  public readonly name = "mineru";

  public async parse(): Promise<ParsedDocument> {
    throw new Error("PARSER_UNAVAILABLE: MinerU parser is not configured");
  }
}

class UnavailableDocumentParser implements DocumentParser {
  public constructor(public readonly name: string) {}

  public async parse(): Promise<ParsedDocument> {
    throw new Error(`PARSER_UNAVAILABLE: ${this.name} parser is not configured`);
  }
}

export class ParserRouter {
  private readonly mineru: DocumentParser;
  private readonly native: DocumentParser;
  private readonly html: DocumentParser;

  public constructor(parsers: Partial<{ mineru: DocumentParser; native: DocumentParser; html: DocumentParser }> = {}) {
    this.mineru = parsers.mineru ?? new UnavailableMineruParser();
    this.native = parsers.native ?? new UnavailableDocumentParser("native-text");
    this.html = parsers.html ?? new UnavailableDocumentParser("html");
  }

  public parserFor(mimeType: string): DocumentParser {
    switch (mimeType.toLowerCase()) {
      case "application/pdf":
      case "image/png":
      case "image/jpeg":
        return this.mineru;
      case "text/plain":
      case "text/markdown":
        return this.native;
      case "text/html":
        return this.html;
      default:
        throw new Error(`UNSUPPORTED_FORMAT: ${mimeType}`);
    }
  }
}

async function readSealedText(input: ParseDocumentInput): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "flowmate-native-input-"));
  const localFile = path.join(directory, input.sourceFile.fileName);
  try {
    await input.sourceFile.copyTo(localFile);
    return readFile(localFile, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeDerivedOutput(
  derivedRoot: string,
  parser: DerivedParser,
  input: ParseDocumentInput,
  output: DerivedOutput,
): Promise<ParsedDocument> {
  const directory = path.join(derivedRoot, input.artifact.artifactId, parser.parserVersion);
  const imagesDirectory = path.join(directory, "images");
  await mkdir(imagesDirectory, { recursive: true });
  const contentRef = path.join(directory, "content.md");
  const structureRef = path.join(directory, "structure.json");
  const metadataRef = path.join(directory, "metadata.json");
  const imageMarker = path.join(imagesDirectory, ".gitkeep");
  const parsedAt = new Date().toISOString();
  const contentSha256 = sha256(output.content);
  await Promise.all([
    writeFile(contentRef, output.content, "utf8"),
    writeFile(structureRef, `${JSON.stringify(output.structure, null, 2)}\n`, "utf8"),
    writeFile(imageMarker, "", "utf8"),
  ]);
  const outputHashes = {
    "content.md": contentSha256,
    "structure.json": sha256(JSON.stringify(output.structure, null, 2) + "\n"),
    "images/.gitkeep": sha256(""),
  };
  await writeFile(metadataRef, `${JSON.stringify({
    artifactId: input.artifact.artifactId,
    sourceSha256: input.artifact.rawSha256,
    parserName: parser.name,
    parserVersion: parser.parserVersion,
    parsedAt,
    outputFiles: Object.keys(outputHashes),
    outputHashes,
    ...(output.pageCount === undefined ? {} : { pageCount: output.pageCount }),
    warnings: output.warnings,
  }, null, 2)}\n`, "utf8");
  const metadataHash = sha256(await readFile(metadataRef));
  await writeFile(
    path.join(directory, "checksums.sha256"),
    [...Object.entries({ ...outputHashes, "metadata.json": metadataHash })]
      .map(([fileName, hash]) => `${hash}  ${fileName}`)
      .join("\n") + "\n",
    "utf8",
  );
  return {
    artifactId: input.artifact.artifactId,
    parserName: parser.name,
    parserVersion: parser.parserVersion,
    parsedAt,
    contentRef,
    structureRef,
    imageRefs: [],
    contentSha256,
    ...(output.pageCount === undefined ? {} : { pageCount: output.pageCount }),
    warnings: output.warnings,
  };
}

function htmlToText(html: string): string {
  const withoutIgnoredElements = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const withBreaks = withoutIgnoredElements.replace(/<\/(?:p|div|h[1-6]|li|br|section|article)>/gi, "\n\n");
  const text = withBreaks.replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&");
  return `${text.split(/\r?\n/).map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
