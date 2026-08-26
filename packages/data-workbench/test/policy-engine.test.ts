import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import cases from "./fixtures/policy-cases.json" with { type: "json" };
import { PolicyEngine } from "../src/policy-engine.js";
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

  it("keeps license, privacy, and quality statuses independent", async () => {
    const engine = new PolicyEngine(new FixedClock());

    const deniedLicense = engine.evaluate(await policyInput(fixture("denied-license")));
    const privatePhone = engine.evaluate(await policyInput(fixture("phone")));
    const emptyContent = engine.evaluate(await policyInput(fixture("empty")));

    expect(deniedLicense).toMatchObject({ licenseStatus: "denied", privacyStatus: "passed", qualityStatus: "passed" });
    expect(privatePhone).toMatchObject({ licenseStatus: "allowed", privacyStatus: "quarantined", qualityStatus: "passed" });
    expect(emptyContent).toMatchObject({ licenseStatus: "allowed", privacyStatus: "passed", qualityStatus: "quarantined" });
  });

  it("does not allow synthetic identifiers into a final acceptance split", async () => {
    const policyCase = fixture("allowed-synthetic-invoice");
    const decision = new PolicyEngine(new FixedClock()).evaluate(await policyInput(policyCase));

    expect(decision.reasonCodes).toContain("SYNTHETIC_IDENTIFIERS_PRESENT");
    expect(decision.reasonCodes).toContain("FINAL_ACCEPTANCE_INELIGIBLE");
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
  await writeFile(contentRef, policyCase.text, "utf8");
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
    rawRef: path.join(root, "raw.pdf"),
    rawSha256: "a".repeat(64),
    mimeType: "text/plain",
    retentionStatus: "retained",
  };
  const parsedDocument: ParsedDocument = {
    artifactId: rawArtifact.artifactId,
    parserName: "native-text",
    parserVersion: "native-text-v1",
    parsedAt: now,
    contentRef,
    imageRefs: [],
    contentSha256: createHash("sha256").update(policyCase.text).digest("hex"),
    warnings: [],
  };
  return { itemId: "SAMPLE-000001", sourcePolicy, rawArtifact, parsedDocument };
}
