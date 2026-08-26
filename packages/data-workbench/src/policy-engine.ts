import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { ParsedDocument, PolicyDecision, RawArtifactRef, SourcePolicy } from "./types.js";

const POLICY_VERSION = "p0-policy-1.0" as const;
const MAX_REASONABLE_PAGE_COUNT = 10_000;

export interface PolicyClock { now(): string; }

export interface PolicyEvaluationInput {
  itemId: string;
  sourcePolicy: SourcePolicy;
  rawArtifact: RawArtifactRef;
  parsedDocument: ParsedDocument;
}

export interface PolicyDeletionAudit {
  itemId: string;
  canonicalUrl?: string;
  rawSha256: string;
  contentSha256: string;
  decidedAt: string;
  policyVersion: PolicyDecision["policyVersion"];
  reasonCodes: string[];
  deletedFileCount: number;
}

type GateFinding = "passed" | "quarantine" | "delete";
interface ContentInspection { content: string; readable: boolean; }
interface FileInspection { contents: Buffer; readable: boolean; }

export class PolicyEngine {
  public constructor(private readonly clock: PolicyClock = { now: () => new Date().toISOString() }) {}

  public evaluate(input: PolicyEvaluationInput): PolicyDecision {
    const reasonCodes = new Set<string>();
    const content = inspectContent(input.parsedDocument, reasonCodes);
    const licenseFinding = assessLicense(input.sourcePolicy, reasonCodes);
    const sourceFinding = assessSourceConstraints(input.sourcePolicy, reasonCodes);
    const privacyFinding = assessPrivacy(content.content, input.sourcePolicy, reasonCodes);
    const qualityFinding = assessQuality(input.rawArtifact, input.parsedDocument, content, reasonCodes);

    return {
      itemId: input.itemId,
      licenseStatus: input.sourcePolicy.sourcePolicy,
      privacyStatus: privacyFinding === "delete" ? "delete_content" : privacyFinding === "quarantine" ? "quarantined" : "passed",
      qualityStatus: qualityFinding === "passed" ? "passed" : "quarantined",
      action: chooseAction(licenseFinding, sourceFinding, privacyFinding, qualityFinding),
      reasonCodes: [...reasonCodes].sort(),
      policyVersion: POLICY_VERSION,
      decidedAt: this.clock.now(),
    };
  }
}

/** Deletes only a previously rejected set of files rooted at a trusted data directory. */
export class PolicyDeletionExecutor {
  private readonly root: string;

  public constructor(deletionRoot: string) {
    this.root = path.resolve(deletionRoot);
  }

  public async execute(input: PolicyEvaluationInput & { decision: PolicyDecision }): Promise<PolicyDeletionAudit> {
    if (input.decision.action !== "delete_content_keep_metadata") {
      throw new Error("Policy deletion requires a delete_content_keep_metadata decision");
    }
    const fileRefs = uniqueFileRefs([
      input.rawArtifact.rawRef,
      input.parsedDocument.contentRef,
      input.parsedDocument.structureRef,
      ...input.parsedDocument.imageRefs,
    ]);
    for (const fileRef of fileRefs) {
      await this.assertSafeTarget(fileRef);
    }

    let deletedFileCount = 0;
    for (const fileRef of fileRefs) {
      const metadata = await lstatIfPresent(fileRef);
      if (!metadata) continue;
      if (metadata.isDirectory()) throw new Error(`Policy deletion only accepts file references: ${fileRef}`);
      await unlink(fileRef);
      deletedFileCount += 1;
    }
    return {
      itemId: input.decision.itemId,
      ...(input.rawArtifact.canonicalUrl ? { canonicalUrl: input.rawArtifact.canonicalUrl } : {}),
      rawSha256: input.rawArtifact.rawSha256,
      contentSha256: input.parsedDocument.contentSha256,
      decidedAt: input.decision.decidedAt,
      policyVersion: input.decision.policyVersion,
      reasonCodes: [...input.decision.reasonCodes],
      deletedFileCount,
    };
  }

  private async assertSafeTarget(fileRef: string): Promise<void> {
    const resolved = path.resolve(fileRef);
    assertContainedPath(this.root, resolved, "Refusing to delete path outside the configured deletion root");
    await assertNoReparsePoint(this.root, resolved);
    const realRoot = await realpath(this.root);
    const realParent = await realpath(path.dirname(resolved));
    assertContainedPath(realRoot, realParent, "Refusing to delete path outside the configured deletion root", true);
    const target = await lstatIfPresent(resolved);
    if (target?.isSymbolicLink()) throw new Error(`Refusing to delete a symbolic link or reparse point: ${fileRef}`);
    if (target) assertContainedPath(realRoot, await realpath(resolved), "Refusing to delete path outside the configured deletion root");
  }
}

function chooseAction(...findings: GateFinding[]): PolicyDecision["action"] {
  return findings.includes("delete") ? "delete_content_keep_metadata" : findings.includes("quarantine") ? "quarantine" : "catalog";
}

function assessLicense(policy: SourcePolicy, reasonCodes: Set<string>): GateFinding {
  let finding: GateFinding = "passed";
  if (policy.sourcePolicy === "denied") { reasonCodes.add("LICENSE_DENIED"); finding = "delete"; }
  else if (policy.sourcePolicy === "unknown") { reasonCodes.add("LICENSE_UNKNOWN"); finding = "quarantine"; }
  if (policy.rawRetention === "denied") { reasonCodes.add("RAW_RETENTION_DENIED"); finding = "delete"; }
  return finding;
}

function assessSourceConstraints(policy: SourcePolicy, reasonCodes: Set<string>): GateFinding {
  let finding: GateFinding = "passed";
  if (!policy.enabled) { reasonCodes.add("SOURCE_DISABLED"); finding = "quarantine"; }
  if (policy.sourceType !== "public_web" || policy.accessStrategy !== "public") { reasonCodes.add("SOURCE_NOT_PUBLIC"); finding = "quarantine"; }
  if (policy.rawRetention === "metadata_only") { reasonCodes.add("RAW_RETENTION_METADATA_ONLY"); finding = "quarantine"; }
  if (policy.datasetUsage !== "allowed") { reasonCodes.add("DATASET_USAGE_DENIED"); finding = "quarantine"; }
  return finding;
}

function assessPrivacy(content: string, policy: SourcePolicy, reasonCodes: Set<string>): GateFinding {
  const declaredSynthetic = isDeclaredSynthetic(policy);
  const supportedSynthetic = declaredSynthetic && (ibanPattern.test(content) || taxIdentifierPattern.test(content));
  let finding: GateFinding = "passed";
  const quarantine = (reasonCode: string): void => {
    reasonCodes.add(reasonCode);
    if (finding !== "delete") finding = "quarantine";
  };

  if (secretPattern.test(content) || awsAccessKeyPattern.test(content) || privateKeyPattern.test(content)) {
    reasonCodes.add("SECRET_DETECTED");
    finding = "delete";
  }
  if (phonePattern.test(content)) quarantine("PHONE_DETECTED");
  if (emailPattern.test(content)) quarantine("EMAIL_DETECTED");
  if (addressPattern.test(content)) quarantine("ADDRESS_DETECTED");
  if (bankAccountPattern.test(content) || (!declaredSynthetic && ibanPattern.test(content))) quarantine("BANK_ACCOUNT_DETECTED");
  if (identityPattern.test(content) || (!declaredSynthetic && taxIdentifierPattern.test(content))) quarantine("IDENTITY_NUMBER_DETECTED");
  if (supportedSynthetic) {
    reasonCodes.add("SYNTHETIC_IDENTIFIERS_PRESENT");
    reasonCodes.add("FINAL_ACCEPTANCE_INELIGIBLE");
  }
  return finding;
}

function inspectContent(parsedDocument: ParsedDocument, reasonCodes: Set<string>): ContentInspection {
  try { return { content: readFileSync(parsedDocument.contentRef, "utf8"), readable: true }; }
  catch { reasonCodes.add("CONTENT_UNREADABLE"); return { content: "", readable: false }; }
}

function assessQuality(
  rawArtifact: RawArtifactRef,
  parsedDocument: ParsedDocument,
  content: ContentInspection,
  reasonCodes: Set<string>,
): GateFinding {
  let finding: GateFinding = "passed";
  const fail = (reasonCode: string): void => { reasonCodes.add(reasonCode); finding = "quarantine"; };
  if (!content.readable || !content.content.trim()) fail("CONTENT_EMPTY");
  if (!rawArtifact.canonicalUrl) fail("SOURCE_URL_MISSING");
  if (!rawArtifact.rawSha256 || !parsedDocument.contentSha256) fail("HASH_MISSING");
  if (!parsedDocument.parserName || !parsedDocument.parserVersion || !parsedDocument.parsedAt) fail("PARSER_METADATA_MISSING");
  if (rawArtifact.artifactId !== parsedDocument.artifactId) fail("ARTIFACT_ID_MISMATCH");
  if (rawArtifact.retentionStatus !== "retained") fail("RAW_ARTIFACT_NOT_RETAINED");

  const raw = inspectFile(rawArtifact.rawRef);
  if (!raw.readable) fail("RAW_ARTIFACT_UNREADABLE");
  else if (rawArtifact.rawSha256 && sha256(raw.contents) !== rawArtifact.rawSha256.toLowerCase()) fail("RAW_HASH_MISMATCH");
  if (content.readable && parsedDocument.contentSha256 && sha256(Buffer.from(content.content)) !== parsedDocument.contentSha256.toLowerCase()) fail("CONTENT_HASH_MISMATCH");
  assessDerivedOutputQuality(parsedDocument, content, fail);
  if (parsedDocument.pageCount !== undefined && (!Number.isInteger(parsedDocument.pageCount) || parsedDocument.pageCount < 1 || parsedDocument.pageCount > MAX_REASONABLE_PAGE_COUNT)) fail("PAGE_COUNT_INVALID");
  if (parsedDocument.imageRefs.length > MAX_REASONABLE_PAGE_COUNT) fail("OUTPUT_COUNT_INVALID");
  if (parsedDocument.warnings.some((warning) => /(?:fatal|corrupt|unreadable)/i.test(warning))) fail("PARSER_FATAL_WARNING");
  return finding;
}

/** P0 requires a structure file for every catalogable derived artifact. */
function assessDerivedOutputQuality(
  parsedDocument: ParsedDocument,
  content: ContentInspection,
  fail: (reasonCode: string) => void,
): void {
  if (!parsedDocument.structureRef) { fail("DERIVED_STRUCTURE_MISSING"); return; }
  const derivedRoot = path.dirname(parsedDocument.contentRef);
  const metadataRef = path.join(derivedRoot, "metadata.json");
  const checksumsRef = path.join(derivedRoot, "checksums.sha256");
  const requiredFiles = new Map<string, string>([
    ["content.md", parsedDocument.contentRef],
    [relativeDerivedRef(derivedRoot, parsedDocument.structureRef, fail), parsedDocument.structureRef],
    ["metadata.json", metadataRef],
    ...parsedDocument.imageRefs.map((imageRef) => [relativeDerivedRef(derivedRoot, imageRef, fail), imageRef] as const),
  ]);
  const structure = inspectFile(parsedDocument.structureRef);
  const metadata = inspectFile(metadataRef);
  const checksums = inspectFile(checksumsRef);
  if (!structure.readable || !metadata.readable || !checksums.readable) { fail("DERIVED_OUTPUT_UNREADABLE"); return; }
  if (!structure.contents.length || !metadata.contents.length || !checksums.contents.length) { fail("DERIVED_OUTPUT_EMPTY"); return; }
  const manifest = parseChecksums(checksums.contents.toString("utf8"));
  if (!manifest) { fail("DERIVED_CHECKSUMS_INVALID"); return; }
  for (const [name, fileRef] of requiredFiles) {
    const output = name === "content.md" && content.readable ? Buffer.from(content.content) : inspectFile(fileRef).contents;
    const expectedHash = manifest.get(name);
    if (!expectedHash || (!output.length && name !== "images/.gitkeep") || expectedHash !== sha256(output)) {
      fail("DERIVED_CHECKSUMS_INVALID");
      return;
    }
  }
  for (const [name, expectedHash] of manifest) {
    const fileRef = path.resolve(derivedRoot, name);
    if (!isRelativeDerivedPath(derivedRoot, fileRef)) { fail("DERIVED_CHECKSUMS_INVALID"); return; }
    const output = inspectFile(fileRef);
    if (!output.readable || expectedHash !== sha256(output.contents)) { fail("DERIVED_CHECKSUMS_INVALID"); return; }
  }
}

function relativeDerivedRef(root: string, fileRef: string, fail: (reasonCode: string) => void): string {
  const resolved = path.resolve(fileRef);
  if (!isRelativeDerivedPath(root, resolved)) { fail("DERIVED_OUTPUT_OUTSIDE"); return "__outside__"; }
  return path.relative(root, resolved).split(path.sep).join("/");
}

function isRelativeDerivedPath(root: string, fileRef: string): boolean {
  const relative = path.relative(root, fileRef);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function parseChecksums(value: string): Map<string, string> | undefined {
  const entries = value.trim().split(/\r?\n/).map((line) => /^([a-f0-9]{64}) {2}(.+)$/i.exec(line));
  if (!entries.length || entries.some((entry) => !entry || !entry[1] || !entry[2])) return undefined;
  const manifest = new Map<string, string>();
  for (const entry of entries) {
    if (!entry?.[1] || !entry[2] || manifest.has(entry[2])) return undefined;
    manifest.set(entry[2], entry[1].toLowerCase());
  }
  return manifest;
}

function inspectFile(fileRef: string | undefined): FileInspection {
  if (!fileRef) return { readable: false, contents: Buffer.alloc(0) };
  try { return { readable: true, contents: readFileSync(fileRef) }; }
  catch { return { readable: false, contents: Buffer.alloc(0) }; }
}

function uniqueFileRefs(fileRefs: Array<string | undefined>): string[] {
  return [...new Set(fileRefs.filter((fileRef): fileRef is string => Boolean(fileRef)))];
}

async function assertNoReparsePoint(root: string, target: string): Promise<void> {
  const rootStats = await lstatIfPresent(root);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) throw new Error("Deletion root must be a real directory, not a symbolic link or reparse point");
  const segments = path.relative(root, target).split(path.sep);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = await lstatIfPresent(current);
    if (!stats) {
      if (index !== segments.length - 1) throw new Error("Deletion target parent directory must already exist");
      return;
    }
    if (stats.isSymbolicLink()) throw new Error(`Refusing to delete through a symbolic link or reparse point: ${current}`);
    if (index !== segments.length - 1 && !stats.isDirectory()) throw new Error(`Deletion target parent must be a directory: ${current}`);
  }
}

function assertContainedPath(root: string, candidate: string, message: string, allowRoot = false): void {
  const relative = path.relative(root, candidate);
  if ((!allowRoot && !relative) || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error(`${message}: ${candidate}`);
}

async function lstatIfPresent(fileRef: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try { return await lstat(fileRef); }
  catch (error: unknown) { if (isNotFound(error)) return undefined; throw error; }
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function sha256(contents: Buffer): string { return createHash("sha256").update(contents).digest("hex"); }
function isDeclaredSynthetic(policy: SourcePolicy): boolean { return policy.sourcePolicy === "allowed" && policy.synthetic && policy.containsSyntheticIdentifiers; }

const secretPattern = /(?:\b(?:api[_-]?key|x-api-key|access[_-]?token|authorization|password|passwd|secret|token|cookie|client[_-]?secret)\b\s*(?:[:=]|is)\s*(?:bearer\s+)?\S+|\bbearer\s+[A-Z0-9._~+\-/]{8,})/i;
const awsAccessKeyPattern = /\bAKIA[0-9A-Z]{16}\b/;
const privateKeyPattern = /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/;
const phonePattern = /(?<!\d)(?:(?:\+?86[-\s]?)?1[3-9]\d{9}|\+[1-9]\d{0,2}[\s.-]?(?:\(?\d{1,4}\)?[\s.-]?){2,4}\d{2,4})(?!\d)/;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const addressPattern = /(?:\b(?:home |residential )?address\s*[:：#]?\s*\d+\s+[^\n,]+|\b\d{1,6}\s+[A-Z][A-Z .'-]{2,}\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct)\b|(?:地址|住址|收货地址)\s*[:：]?\s*[^\n]{4,})/i;
const ibanPattern = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/i;
const bankAccountPattern = /\b(?:\d[ -]?){13,19}\d\b/;
const taxIdentifierPattern = /\b(?:tax\s*(?:id|identifier)|vat\s*(?:id|number))\s*[:#]?\s*[A-Z0-9-]{6,}\b/i;
const identityPattern = /\b(?:[1-9]\d{5}(?:19|20)\d{2}(?:(?:0[1-9])|(?:1[0-2]))(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]|(?!000|666|9\d\d)\d{3}-\d{2}-\d{4})\b/;
