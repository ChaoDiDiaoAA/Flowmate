import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HtmlContentParser, MineruDocumentParser, NativeTextParser, ParserRouter, type MineruDocumentClient } from "../src/parser-router.js";
import { MineruMcpClient, type MineruParsedFile } from "../src/mineru-mcp-client.js";
import { SealedStagedFile } from "../src/sealed-staged-file.js";
import type { RawArtifactRef } from "../src/types.js";

const temporaryRoots: string[] = [];

function artifact(mimeType: string): RawArtifactRef {
  return {
    artifactId: "ART-000001",
    sourceIds: ["SRC-000001"],
    acquisitionJobIds: ["ACQ-20260826-0001"],
    rawSha256: "a".repeat(64),
    mimeType,
    retentionStatus: "retained",
  };
}

async function sealed(contents: string, fileName: string): Promise<SealedStagedFile> {
  const staged = await SealedStagedFile.create("ACQ-20260826-0001", fileName);
  await writeFile(staged.targetFile, contents, "utf8");
  return staged.seal();
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ParserRouter", () => {
  it.each([
    ["application/pdf", "mineru"],
    ["image/png", "mineru"],
    ["text/plain", "native-text"],
    ["text/markdown", "native-text"],
    ["text/html", "html"],
  ])("routes %s to %s", (mimeType, parserName) => {
    const router = new ParserRouter();
    expect(router.parserFor(mimeType).name).toBe(parserName);
  });

  it("rejects unsupported binary media", () => {
    const router = new ParserRouter();
    expect(() => router.parserFor("application/octet-stream")).toThrow(/UNSUPPORTED_FORMAT/);
  });

  it("writes native derived content, metadata, structure, and checksums from a sealed file handle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-parser-router-"));
    temporaryRoots.push(root);
    const fixture = await readFile(new URL("./fixtures/plain-document.txt", import.meta.url), "utf8");
    const input = await sealed(fixture, "plain-document.txt");
    const parser = new NativeTextParser(path.join(root, "derived", "native"));

    const parsed = await parser.parse({ artifact: artifact("text/plain"), sourceFile: input });

    const outputDir = path.join(root, "derived", "native", "ART-000001", "native-text-v1");
    expect(parsed).toMatchObject({
      artifactId: "ART-000001",
      parserName: "native-text",
      parserVersion: "native-text-v1",
      contentRef: path.join(outputDir, "content.md"),
      structureRef: path.join(outputDir, "structure.json"),
      imageRefs: [],
      contentSha256: createHash("sha256").update("First line\nSecond line\n").digest("hex"),
      warnings: [],
    });
    await expect(readFile(path.join(outputDir, "content.md"), "utf8")).resolves.toBe("First line\nSecond line\n");
    await expect(readFile(path.join(outputDir, "structure.json"), "utf8"))
      .resolves.toContain('"lineCount": 2');
    await expect(readFile(path.join(outputDir, "metadata.json"), "utf8"))
      .resolves.toContain('"sourceSha256": "aaaaaaaa');
    await expect(readFile(path.join(outputDir, "checksums.sha256"), "utf8"))
      .resolves.toMatch(/content\.md/);
    await input.dispose();
  });

  it("extracts visible HTML text into the same derived-artifact shape", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-parser-router-"));
    temporaryRoots.push(root);
    const input = await sealed("<html><body><h1>Title</h1><script>ignored()</script><p>Invoice 84652373</p></body></html>", "invoice.html");
    const parser = new HtmlContentParser(path.join(root, "derived", "html"));

    const parsed = await parser.parse({ artifact: artifact("text/html"), sourceFile: input });

    await expect(readFile(parsed.contentRef, "utf8")).resolves.toBe("Title\n\nInvoice 84652373\n");
    await expect(readFile(path.join(path.dirname(parsed.contentRef), "images", ".gitkeep"), "utf8")).resolves.toBe("");
    await input.dispose();
  });

  it("redacts untrusted MinerU warning secrets before they reach derived metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-parser-router-"));
    temporaryRoots.push(root);
    const input = await sealed("image bytes", "invoice.jpg");
    const client = {
      parseDocuments: async (): Promise<MineruParsedFile[]> => [{
        filename: "invoice.jpg",
        content: "Invoice content",
        contentChars: 15,
        truncated: false,
        warnings: [
          "download failed https://cdn.example/result?signature=secret-signature",
          "Authorization: Bearer secret-bearer",
          "api_key=secret-api-key",
        ],
      }],
    } satisfies MineruDocumentClient;
    const parser = new MineruDocumentParser(client, path.join(root, "derived", "mineru"));

    const parsed = await parser.parse({ artifact: artifact("image/jpeg"), sourceFile: input });
    const metadata = await readFile(path.join(path.dirname(parsed.contentRef), "metadata.json"), "utf8");

    expect(metadata).not.toMatch(/secret-signature|secret-bearer|secret-api-key/i);
    expect(metadata).toContain("[REDACTED]");
    expect(parsed.warnings.join("\n")).not.toMatch(/secret-signature|secret-bearer|secret-api-key/i);
    await input.dispose();
  });

  it("materializes a hostile staged filename under a basename-only temporary path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-parser-router-"));
    temporaryRoots.push(root);
    let copiedTo: string | undefined;
    const hostileSource = {
      fileName: "..\\untrusted.txt",
      copyTo: async (destination: string): Promise<void> => {
        copiedTo = destination;
        await writeFile(destination, "safe text", "utf8");
      },
    } as SealedStagedFile;
    const parser = new NativeTextParser(path.join(root, "derived", "native"));

    try {
      await expect(parser.parse({ artifact: artifact("text/plain"), sourceFile: hostileSource })).resolves.toMatchObject({
        contentSha256: createHash("sha256").update("safe text").digest("hex"),
      });
      expect(path.basename(copiedTo!)).toBe("untrusted.txt");
      expect(path.basename(path.dirname(copiedTo!))).toMatch(/^flowmate-native-input-/);
    } finally {
      if (copiedTo) {
        await rm(copiedTo, { force: true });
      }
    }
  });

  it.runIf(process.env.FLOWMATE_RUN_MINERU_INTEGRATION === "1")("parses the retained public invoice JPEG through the project wrapper from a sealed staging copy", async () => {
    const projectRoot = path.resolve(process.cwd(), "..", "..");
    const rawFile = path.join(
      projectRoot,
      "FlowmateData",
      "web-raw",
      "huggingface.co",
      "ACQ-20260826-0002",
      "ART-000001",
      "files",
      "batch1-0494.jpg",
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-mineru-integration-"));
    temporaryRoots.push(root);
    const staged = await SealedStagedFile.create("ACQ-20260826-0002", "batch1-0494.jpg");
    await copyFile(rawFile, staged.targetFile);
    const sourceFile = await staged.seal();
    const ocrLanguage = process.env.FLOWMATE_MINERU_OCR_LANGUAGE || undefined;
    const enableOcr = process.env.FLOWMATE_MINERU_ENABLE_OCR === "true";
    const client = MineruMcpClient.usingProjectWrapper({
      maxFilesPerRun: 200,
      ...(ocrLanguage === undefined ? {} : { ocrLanguage }),
      ...(enableOcr ? { enableOcr: true } : {}),
    });
    const parser = new MineruDocumentParser(
      client,
      path.join(root, "derived", "mineru"),
    );

    try {
      const parsed = await parser.parse({
        artifact: {
          ...artifact("image/jpeg"),
          rawSha256: "2c4cd305a510de6ddb573e81067e5ed8a6af4fcaf0a7fc678f52f914702e6a60",
        },
        sourceFile,
      });

      await expect(readFile(parsed.contentRef, "utf8")).resolves.toContain("84652373");
      await expect(readFile(path.join(path.dirname(parsed.contentRef), "checksums.sha256"), "utf8"))
        .resolves.toMatch(/^[a-f0-9]{64} {2}content\.md/m);
    } finally {
      await client.close();
      await sourceFile.dispose();
    }
  }, 240_000);
});
