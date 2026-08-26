import { readFileSync } from "node:fs";
import type { ParsedDocument, PolicyDecision, RawArtifactRef, SourcePolicy } from "./types.js";

const POLICY_VERSION = "p0-policy-1.0" as const;

export interface PolicyClock {
  now(): string;
}

export interface PolicyEvaluationInput {
  itemId: string;
  sourcePolicy: SourcePolicy;
  rawArtifact: RawArtifactRef;
  parsedDocument: ParsedDocument;
}

export class PolicyEngine {
  public constructor(private readonly clock: PolicyClock = { now: () => new Date().toISOString() }) {}

  public evaluate(input: PolicyEvaluationInput): PolicyDecision {
    const reasonCodes = new Set<string>();
    const content = readContent(input.parsedDocument, reasonCodes);
    const syntheticIdentifiersAreDeclared = isDeclaredSynthetic(input.sourcePolicy);

    const privacyFinding = assessPrivacy(content, syntheticIdentifiersAreDeclared, reasonCodes);
    const deleteContent = assessLicense(input.sourcePolicy, reasonCodes) || privacyFinding === "delete";
    const quarantine = privacyFinding === "quarantine"
      || assessSourceConstraints(input.sourcePolicy, reasonCodes)
      || assessQuality(input.rawArtifact, input.parsedDocument, content, reasonCodes);

    if (syntheticIdentifiersAreDeclared && hasSyntheticIdentifierSignal(content)) {
      reasonCodes.add("SYNTHETIC_IDENTIFIERS_PRESENT");
      reasonCodes.add("FINAL_ACCEPTANCE_INELIGIBLE");
    }

    return {
      itemId: input.itemId,
      licenseStatus: input.sourcePolicy.sourcePolicy,
      privacyStatus: privacyFinding === "delete"
        ? "delete_content"
        : privacyFinding === "quarantine"
          ? "quarantined"
          : "passed",
      qualityStatus: hasQualityFailure(reasonCodes) ? "quarantined" : "passed",
      action: deleteContent ? "delete_content_keep_metadata" : quarantine ? "quarantine" : "catalog",
      reasonCodes: [...reasonCodes].sort(),
      policyVersion: POLICY_VERSION,
      decidedAt: this.clock.now(),
    };
  }
}

function readContent(parsedDocument: ParsedDocument, reasonCodes: Set<string>): string {
  try {
    return readFileSync(parsedDocument.contentRef, "utf8");
  } catch {
    reasonCodes.add("CONTENT_UNREADABLE");
    return "";
  }
}

function assessLicense(policy: SourcePolicy, reasonCodes: Set<string>): boolean {
  if (policy.sourcePolicy === "denied") {
    reasonCodes.add("LICENSE_DENIED");
  } else if (policy.sourcePolicy === "unknown") {
    reasonCodes.add("LICENSE_UNKNOWN");
  }
  if (policy.rawRetention === "denied") {
    reasonCodes.add("RAW_RETENTION_DENIED");
  }
  return policy.sourcePolicy === "denied" || policy.rawRetention === "denied";
}

function assessSourceConstraints(policy: SourcePolicy, reasonCodes: Set<string>): boolean {
  let failed = policy.sourcePolicy === "unknown";
  if (!policy.enabled) {
    reasonCodes.add("SOURCE_DISABLED");
    failed = true;
  }
  if (policy.sourceType !== "public_web" || policy.accessStrategy !== "public") {
    reasonCodes.add("SOURCE_NOT_PUBLIC");
    failed = true;
  }
  if (policy.rawRetention === "metadata_only") {
    reasonCodes.add("RAW_RETENTION_METADATA_ONLY");
    failed = true;
  }
  if (policy.datasetUsage !== "allowed") {
    reasonCodes.add("DATASET_USAGE_DENIED");
    failed = true;
  }
  return failed;
}

function assessPrivacy(
  content: string,
  syntheticIdentifiersAreDeclared: boolean,
  reasonCodes: Set<string>,
): "passed" | "quarantine" | "delete" {
  if (secretPattern.test(content)) {
    reasonCodes.add("SECRET_DETECTED");
    return "delete";
  }

  const privateIdentifierDetected = phonePattern.test(content)
    || bankAccountPattern.test(content)
    || identityPattern.test(content)
    || emailPattern.test(content);
  if (!privateIdentifierDetected || syntheticIdentifiersAreDeclared) {
    return "passed";
  }
  if (phonePattern.test(content)) {
    reasonCodes.add("PHONE_DETECTED");
  }
  if (bankAccountPattern.test(content)) {
    reasonCodes.add("BANK_ACCOUNT_DETECTED");
  }
  if (identityPattern.test(content)) {
    reasonCodes.add("IDENTITY_NUMBER_DETECTED");
  }
  if (emailPattern.test(content)) {
    reasonCodes.add("EMAIL_DETECTED");
  }
  return "quarantine";
}

function assessQuality(
  rawArtifact: RawArtifactRef,
  parsedDocument: ParsedDocument,
  content: string,
  reasonCodes: Set<string>,
): boolean {
  let failed = false;
  if (!content.trim()) {
    reasonCodes.add("CONTENT_EMPTY");
    failed = true;
  }
  if (!rawArtifact.canonicalUrl) {
    reasonCodes.add("SOURCE_URL_MISSING");
    failed = true;
  }
  if (!rawArtifact.rawSha256 || !parsedDocument.contentSha256) {
    reasonCodes.add("HASH_MISSING");
    failed = true;
  }
  if (!parsedDocument.parserName || !parsedDocument.parserVersion) {
    reasonCodes.add("PARSER_METADATA_MISSING");
    failed = true;
  }
  if (parsedDocument.warnings.some((warning) => /(?:fatal|corrupt|unreadable)/i.test(warning))) {
    reasonCodes.add("PARSER_FATAL_WARNING");
    failed = true;
  }
  return failed;
}

function hasQualityFailure(reasonCodes: Set<string>): boolean {
  return [
    "CONTENT_EMPTY",
    "CONTENT_UNREADABLE",
    "SOURCE_URL_MISSING",
    "HASH_MISSING",
    "PARSER_METADATA_MISSING",
    "PARSER_FATAL_WARNING",
  ].some((reasonCode) => reasonCodes.has(reasonCode));
}

function isDeclaredSynthetic(policy: SourcePolicy): boolean {
  return policy.sourcePolicy === "allowed"
    && policy.synthetic
    && policy.containsSyntheticIdentifiers;
}

function hasSyntheticIdentifierSignal(content: string): boolean {
  return bankAccountPattern.test(content) || identityPattern.test(content);
}

const secretPattern = /\b(?:api[_-]?key|access[_-]?token|authorization|password|passwd|secret|token|cookie)\b\s*(?:[:=]|is)\s*(?:bearer\s+)?\S+/i;
const phonePattern = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/;
const bankAccountPattern = /\b(?:[A-Z]{2}\d{2}[A-Z0-9]{11,30}|(?:\d[ -]?){13,19}\d)\b/i;
const identityPattern = /\b(?:[1-9]\d{5}(?:19|20)\d{2}(?:(?:0[1-9])|(?:1[0-2]))(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]|(?!000|666|9\d\d)\d{3}-\d{2}-\d{4})\b/;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
