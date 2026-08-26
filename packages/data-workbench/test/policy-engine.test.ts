import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import cases from "./fixtures/policy-cases.json" with { type: "json" };
import { PolicyDeletionExecutor, PolicyEngine } from "../src/policy-engine.js";
import type { ParsedDocument, RawArtifactRef, SourcePolicy } from "../src/types.js";

const temporaryRoots: string[] = [];
const now = "2026-08-26T12:00:00.000Z";
type PolicyInput = Parameters<PolicyEngine["evaluate"]>[0];

class FixedClock {
  public now(): string {
    return now;
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("PolicyEngine", () => {
  it.each(cases)("applies the fixture action for $name", async (policyCase) => {
    const input = await policyInput(policyCase);

    const decision = new PolicyEngine(new FixedClock()).evaluate(input);

    expect(decision.action).toBe(policyCase.want);
    expect(decision.policyVersion).toBe("p0-policy-1.0");
    expect(decision.decidedAt).toBe(now);
  });

  it("records the required deterministic reason codes", async () => {
    const engine = new PolicyEngine(new FixedClock());

    await expectReason(engine, "allowed-synthetic-invoice", "SYNTHETIC_IDENTIFIERS_PRESENT");
    await expectReason(engine, "unknown-license", "LICENSE_UNKNOWN");
    await expectReason(engine, "denied-license", "LICENSE_DENIED");
    await expectReason(engine, "api-key", "SECRET_DETECTED");
    await expectReason(engine, "phone", "PHONE_DETECTED");
    await expectReason(engine, "empty", "CONTENT_EMPTY");
  });

  it.each([
    ["email", "EMAIL_DETECTED"],
    ["bank-account", "BANK_ACCOUNT_DETECTED"],
    ["identity-number", "IDENTITY_NUMBER_DETECTED"],
    ["address", "ADDRESS_DETECTED"],
    ["credential-variant", "SECRET_DETECTED"],
    ["missing-raw-artifact", "RAW_ARTIFACT_UNREADABLE"],
    ["unreadable-derived-artifact", "CONTENT_UNREADABLE"],
    ["unreadable-derived-output", "DERIVED_OUTPUT_UNREADABLE"],
    ["raw-hash-mismatch", "RAW_HASH_MISMATCH"],
    ["content-hash-mismatch", "CONTENT_HASH_MISMATCH"],
    ["invalid-page-count", "PAGE_COUNT_INVALID"],
    ["empty-derived-structure", "DERIVED_OUTPUT_EMPTY"],
    ["invalid-derived-checksums", "DERIVED_CHECKSUMS_INVALID"],
    ["client-secret", "SECRET_DETECTED"],
    ["international-phone", "PHONE_DETECTED"],
    ["unlabeled-address", "ADDRESS_DETECTED"],
  ])("records %s as %s", async (name, reasonCode) => {
    const decision = new PolicyEngine(new FixedClock()).evaluate(await policyInput(fixture(name)));

    expect(decision.reasonCodes).toContain(reasonCode);
  });

  it("keeps license, privacy, and quality statuses independent", async () => {
    const engine = new PolicyEngine(new FixedClock());

    const deniedLicense = engine.evaluate(await policyInput(fixture("denied-license")));
    const privatePhone = engine.evaluate(await policyInput(fixture("phone")));
    const emptyContent = engine.evaluate(await policyInput(fixture("empty")));

    expect(deniedLicense).toMatchObject({ licenseStatus: "denied", privacyStatus: "passed", qualityStatus: "passed" });
    expect(privatePhone).toMatchObject({ licenseStatus: "allowed", privacyStatus: "quarantined", qualityStatus: "passed" });
    expect(emptyContent).toMatchObject({ licenseStatus: "allowed", privacyStatus: "passed", qualityStatus: "quarantined" });
  });

  it("collects every license, source, privacy, and quality failure in a mixed decision", async () => {
    const input = await policyInput(fixture("denied-license"));
    input.sourcePolicy.enabled = false;
    input.sourcePolicy.rawRetention = "denied";
    input.sourcePolicy.datasetUsage = "denied";
    input.parsedDocument.contentSha256 = "b".repeat(64);
    await writeFile(input.parsedDocument.contentRef, "API_KEY=secret-value phone 13800138000", "utf8");

    const decision = new PolicyEngine(new FixedClock()).evaluate(input);

    expect(decision).toMatchObject({
      licenseStatus: "denied",
      privacyStatus: "delete_content",
      qualityStatus: "quarantined",
      action: "delete_content_keep_metadata",
    });
    expect(decision.reasonCodes).toEqual(expect.arrayContaining([
      "LICENSE_DENIED",
      "RAW_RETENTION_DENIED",
      "SOURCE_DISABLED",
      "DATASET_USAGE_DENIED",
      "SECRET_DETECTED",
      "PHONE_DETECTED",
      "CONTENT_HASH_MISMATCH",
    ]));
  });

  it("does not allow synthetic identifiers into a final acceptance split", async () => {
    const policyCase = fixture("allowed-synthetic-invoice");
    const decision = new PolicyEngine(new FixedClock()).evaluate(await policyInput(policyCase));

    expect(decision.reasonCodes).toContain("SYNTHETIC_IDENTIFIERS_PRESENT");
    expect(decision.reasonCodes).toContain("FINAL_ACCEPTANCE_INELIGIBLE");
  });

  it("does not let synthetic invoice policy bypass phone or email detection", async () => {
    const engine = new PolicyEngine(new FixedClock());
    const phoneDecision = engine.evaluate(await policyInput(fixture("synthetic-phone")));
    const emailInput = await policyInput(fixture("allowed-synthetic-invoice"));
    const emailContent = "IBAN GB91YXO05542456978150 jane.doe@example.com";
    await writeFile(emailInput.parsedDocument.contentRef, emailContent, "utf8");
    emailInput.parsedDocument.contentSha256 = createHash("sha256").update(emailContent).digest("hex");
    const emailDecision = engine.evaluate(emailInput);

    expect(phoneDecision).toMatchObject({ action: "quarantine", privacyStatus: "quarantined" });
    expect(phoneDecision.reasonCodes).toContain("PHONE_DETECTED");
    expect(emailDecision).toMatchObject({ action: "quarantine", privacyStatus: "quarantined" });
    expect(emailDecision.reasonCodes).toContain("EMAIL_DETECTED");
  });

  it("does not let caller-supplied model or quality flags override deterministic scans", async () => {
    const policyCase = fixture("api-key");
    const input = await policyInput(policyCase);
    const untrustedInput = {
      ...input,
      llmLicenseStatus: "allowed",
      llmPrivacyStatus: "passed",
      quality: "good",
    };

    const decision = new PolicyEngine(new FixedClock()).evaluate(untrustedInput);

    expect(decision.action).toBe("delete_content_keep_metadata");
    expect(decision.reasonCodes).toContain("SECRET_DETECTED");
  });

  it("returns deletion decisions without content or file references while retaining auditable decision fields", async () => {
    const policyCase = fixture("denied-license");
    const input = await policyInput(policyCase);
    const decision = new PolicyEngine(new FixedClock()).evaluate(input);

    expect(decision).toMatchObject({
      action: "delete_content_keep_metadata",
      itemId: input.itemId,
      policyVersion: "p0-policy-1.0",
      decidedAt: now,
      reasonCodes: ["LICENSE_DENIED"],
    });
    expect(decision).not.toHaveProperty("contentRef");
    expect(decision).not.toHaveProperty("rawRef");
    expect(decision).not.toHaveProperty("fileRef");
  });

  it("deletes only policy-rejected content under its configured root and returns audit metadata", async () => {
    const input = await policyInput(fixture("denied-license"));
    const decision = new PolicyEngine(new FixedClock()).evaluate(input);
    const root = path.dirname(input.parsedDocument.contentRef);

    const audit = await new PolicyDeletionExecutor(root).execute({ decision, ...input });

    await expect(readFile(input.rawArtifact.rawRef!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(input.parsedDocument.contentRef, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(input.parsedDocument.structureRef!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(audit).toEqual({
      itemId: input.itemId,
      canonicalUrl: input.rawArtifact.canonicalUrl,
      rawSha256: input.rawArtifact.rawSha256,
      contentSha256: input.parsedDocument.contentSha256,
      decidedAt: now,
      policyVersion: "p0-policy-1.0",
      reasonCodes: ["LICENSE_DENIED"],
      deletedFileCount: 3,
    });
    expect(audit).not.toHaveProperty("contentRef");
    expect(audit).not.toHaveProperty("rawRef");
  });

  it("refuses to delete a reference outside its configured root", async () => {
    const input = await policyInput(fixture("denied-license"));
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "flowmate-policy-outside-"));
    temporaryRoots.push(outsideRoot);
    const outsideRaw = path.join(outsideRoot, "raw.txt");
    await writeFile(outsideRaw, "outside", "utf8");
    input.rawArtifact.rawRef = outsideRaw;
    const decision = new PolicyEngine(new FixedClock()).evaluate(input);

    await expect(new PolicyDeletionExecutor(path.dirname(input.parsedDocument.contentRef)).execute({ decision, ...input }))
      .rejects.toThrow(/outside the configured deletion root/i);
    await expect(readFile(outsideRaw, "utf8")).resolves.toBe("outside");
  });

  it("rejects a junction-backed reference before an outside victim can be deleted", async () => {
    const input = await policyInput(fixture("denied-license"));
    const root = path.dirname(input.parsedDocument.contentRef);
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "flowmate-policy-junction-outside-"));
    temporaryRoots.push(outsideRoot);
    const outsideVictim = path.join(outsideRoot, "victim.txt");
    const junction = path.join(root, "junction");
    await writeFile(outsideVictim, "outside victim", "utf8");
    await symlink(outsideRoot, junction, process.platform === "win32" ? "junction" : "dir");
    input.rawArtifact.rawRef = path.join(junction, "victim.txt");
    input.rawArtifact.rawSha256 = createHash("sha256").update("outside victim").digest("hex");
    const decision = new PolicyEngine(new FixedClock()).evaluate(input);

    await expect(new PolicyDeletionExecutor(root).execute({ decision, ...input }))
      .rejects.toThrow(/reparse|symbolic|deletion root/i);
    await expect(readFile(outsideVictim, "utf8")).resolves.toBe("outside victim");
  });

  it("rejects a configured deletion root below an ancestor junction", async () => {
    const input = await policyInput(fixture("denied-license"));
    const anchor = await mkdtemp(path.join(os.tmpdir(), "flowmate-policy-ancestor-anchor-"));
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "flowmate-policy-ancestor-outside-"));
    temporaryRoots.push(anchor, outsideRoot);
    const physicalRoot = path.join(outsideRoot, "nested");
    const junction = path.join(anchor, "junction");
    await mkdir(physicalRoot, { recursive: true });
    await symlink(outsideRoot, junction, process.platform === "win32" ? "junction" : "dir");
    const victim = path.join(physicalRoot, "victim.txt");
    const contentRef = path.join(physicalRoot, "content.md");
    const structureRef = path.join(physicalRoot, "structure.json");
    await Promise.all([writeFile(victim, "outside victim", "utf8"), writeFile(contentRef, "content", "utf8"), writeFile(structureRef, "{}", "utf8")]);
    input.rawArtifact.rawRef = victim;
    input.rawArtifact.rawSha256 = createHash("sha256").update("outside victim").digest("hex");
    input.parsedDocument.contentRef = contentRef;
    input.parsedDocument.contentSha256 = createHash("sha256").update("content").digest("hex");
    input.parsedDocument.structureRef = structureRef;
    const decision = new PolicyEngine(new FixedClock()).evaluate(input);

    await expect(new PolicyDeletionExecutor(path.join(junction, "nested")).execute({ decision, ...input }))
      .rejects.toThrow(/reparse|symbolic|deletion root/i);
    await expect(readFile(victim, "utf8")).resolves.toBe("outside victim");
  });

  it("quarantines a matching-hash derived structure reached through a junction", async () => {
    const input = await policyInput(fixture("allowed-public"));
    const derivedRoot = path.dirname(input.parsedDocument.contentRef);
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "flowmate-policy-derived-outside-"));
    temporaryRoots.push(outsideRoot);
    const junction = path.join(derivedRoot, "junction");
    const outsideStructure = path.join(outsideRoot, "structure.json");
    await writeFile(outsideStructure, "{\"outside\":true}\n", "utf8");
    await symlink(outsideRoot, junction, process.platform === "win32" ? "junction" : "dir");
    input.parsedDocument.structureRef = path.join(junction, "structure.json");
    await writeChecksums(path.join(derivedRoot, "checksums.sha256"), {
      "content.md": "public invoice rule",
      "junction/structure.json": "{\"outside\":true}\n",
      "metadata.json": "{}\n",
    });

    const decision = new PolicyEngine(new FixedClock()).evaluate(input);

    expect(decision).toMatchObject({ action: "quarantine", qualityStatus: "quarantined" });
    expect(decision.reasonCodes).toContain("DERIVED_OUTPUT_REPARSE");
  });
});

async function expectReason(engine: PolicyEngine, name: string, reasonCode: string): Promise<void> {
  const decision = engine.evaluate(await policyInput(fixture(name)));
  expect(decision.reasonCodes).toContain(reasonCode);
}

function fixture(name: string): (typeof cases)[number] {
  const policyCase = cases.find((candidate) => candidate.name === name);
  if (!policyCase) {
    throw new Error(`Missing policy fixture: ${name}`);
  }
  return policyCase;
}

async function policyInput(policyCase: (typeof cases)[number]): Promise<PolicyInput> {
  const root = await mkdtemp(path.join(os.tmpdir(), "flowmate-policy-engine-"));
  temporaryRoots.push(root);
  const contentRef = path.join(root, "content.md");
  const rawRef = path.join(root, "raw.txt");
  const structureRef = path.join(root, "structure.json");
  const metadataRef = path.join(root, "metadata.json");
  const checksumsRef = path.join(root, "checksums.sha256");
  await writeFile(contentRef, policyCase.text, "utf8");
  await writeFile(rawRef, "raw source", "utf8");
  await writeFile(structureRef, "{}", "utf8");
  await writeFile(metadataRef, "{}\n", "utf8");
  await writeChecksums(checksumsRef, { "content.md": policyCase.text, "structure.json": "{}", "metadata.json": "{}\n" });
  const sourcePolicy: SourcePolicy = {
    sourceId: "SRC-000001",
    domain: "example.com",
    sourceType: (policyCase.sourceType ?? "public_web") as SourcePolicy["sourceType"],
    accessStrategy: "public",
    sourcePolicy: policyCase.license as SourcePolicy["sourcePolicy"],
    rawRetention: (policyCase.rawRetention ?? "allowed") as SourcePolicy["rawRetention"],
    datasetUsage: (policyCase.datasetUsage ?? "allowed") as SourcePolicy["datasetUsage"],
    synthetic: policyCase.synthetic,
    containsSyntheticIdentifiers: policyCase.containsSyntheticIdentifiers,
    enabled: policyCase.enabled ?? true,
  };
  const rawArtifact: RawArtifactRef = {
    artifactId: "ART-000001",
    sourceIds: [sourcePolicy.sourceId],
    acquisitionJobIds: ["ACQ-20260826-0001"],
    canonicalUrl: "https://example.com/public-invoice",
    rawRef,
    rawSha256: createHash("sha256").update("raw source").digest("hex"),
    mimeType: "text/plain",
    retentionStatus: "retained",
  };
  const parsedDocument: ParsedDocument = {
    artifactId: rawArtifact.artifactId,
    parserName: "native-text",
    parserVersion: "native-text-v1",
    parsedAt: now,
    contentRef,
    structureRef,
    imageRefs: [],
    contentSha256: createHash("sha256").update(policyCase.text).digest("hex"),
    warnings: [],
  };
  switch (policyCase.quality) {
    case "missing-raw":
      await unlink(rawRef);
      break;
    case "missing-derived":
      await unlink(contentRef);
      break;
    case "bad-content-hash":
      parsedDocument.contentSha256 = "b".repeat(64);
      break;
    case "fatal-warning":
      parsedDocument.warnings = ["Fatal parser corruption"];
      break;
    case "missing-structure":
      await unlink(structureRef);
      break;
    case "bad-raw-hash":
      rawArtifact.rawSha256 = "b".repeat(64);
      break;
    case "invalid-page-count":
      parsedDocument.pageCount = 0;
      break;
    case "empty-structure":
      await writeFile(structureRef, "", "utf8");
      break;
    case "invalid-checksums":
      await writeFile(checksumsRef, "not a checksum\n", "utf8");
      break;
  }
  return { itemId: "SAMPLE-000001", sourcePolicy, rawArtifact, parsedDocument };
}

async function writeChecksums(checksumsRef: string, files: Record<string, string>): Promise<void> {
  const contents = Object.entries(files)
    .map(([name, content]) => `${createHash("sha256").update(content).digest("hex")}  ${name}`)
    .join("\n") + "\n";
  await writeFile(checksumsRef, contents, "utf8");
}
