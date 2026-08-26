import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";

const vaultDirectories = [
  "00_Dashboard",
  "10_Sources",
  "20_AcquisitionJobs",
  "30_PublicKnowledge",
  "40_PublicSamples",
  "50_BusinessAssets",
  "60_DatasetReleases",
  "70_Quarantine",
  "80_Failures",
  "90_Templates",
];

const templates: Record<string, Record<string, unknown>> = {
  "Source.md": {
    source_id: "SRC-000001", name: "来源名称", domain: "example.com", source_type: "public_web",
    access_strategy: "public", source_policy: "allowed", raw_retention: "allowed", dataset_usage: "allowed",
    license_rule: "explicit_or_verified", privacy_rule: "no_sensitive_personal_data", synthetic: false,
    contains_synthetic_identifiers: false, enabled: true,
  },
  "Acquisition Job.md": {
    job_id: "ACQ-YYYYMMDD-0001", source_id: "SRC-000001", objective: "采集目标", query: "查询内容",
    adapter_ref: "dynamically_discovered", strategy: "public", started_at: "", finished_at: "", items_discovered: 0,
    items_stored: 0, items_duplicated: 0, items_quarantined: 0, items_failed: 0, status: "created",
  },
  "Public Knowledge.md": {
    knowledge_id: "KNOW-000001", title: "", source_id: "SRC-000001", artifact_id: "ART-000001", category: "",
    source_url: "", retrieved_at: "", raw_sha256: "", content_sha256: "", license_status: "allowed",
    privacy_status: "passed", quality_status: "passed", pipeline_status: "cataloged", tags: [],
  },
  "Public Sample.md": {
    sample_id: "SAMPLE-000001", source_id: "SRC-000001", artifact_id: "ART-000001", sample_type: "",
    raw_file_ref: "", derived_ref: "", raw_sha256: "", content_sha256: "", file_format: "", parser_name: "",
    parser_version: "", label_status: "unlabeled", scenarios: [], license_status: "allowed", privacy_status: "passed",
    quality_status: "passed", pipeline_status: "cataloged", dataset_version: "unassigned",
  },
  "Business Asset.md": {
    business_asset_id: "BIZ-000001", source_type: "internal_finance", data_owner_role: "finance_ap",
    authorization_status: "approved_for_development", raw_file_ref: "", sanitized_file_ref: "", expected_ref: "",
    raw_sha256: "", business_review_status: "approved", dataset_version: "unassigned",
  },
  "Dataset Release.md": {
    dataset_version: "dataset-v0.1", manifest_ref: "", checksums_ref: "", knowledge_count: 0, public_sample_count: 0,
    business_asset_count: 0, created_at: "", status: "released",
  },
};

export async function initializeObsidianVault(vault: string): Promise<void> {
  await Promise.all(vaultDirectories.map(async (directory) => mkdir(path.join(vault, directory), { recursive: true })));
  await Promise.all(Object.entries(templates).map(async ([filename, metadata]) => {
    try {
      await writeFile(path.join(vault, "90_Templates", filename), `---\n${stringify(metadata)}---\n`, { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
  }));
}
