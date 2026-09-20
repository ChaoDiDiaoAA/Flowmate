"""Read-only P0 source closure audit.

This audit verifies the identity and structural closure that a product adapter
can prove from the current source manifest. It deliberately does not promote
OCR text, provider labels, or machine similarity into business truth. The
output belongs in an evidence/report directory, never in the active data root.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from datetime import datetime, timezone
from hashlib import sha256
import io
import json
from pathlib import Path
import re
from typing import Any

from PIL import Image


VERSION = "p0-source-audit/v1"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png")


def digest_bytes(value: bytes) -> str:
    return sha256(value).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def descriptor_check(path: Path, descriptor: dict[str, Any]) -> bytes:
    raw = path.read_bytes()
    if len(raw) != descriptor.get("bytes"):
        raise ValueError("bytes_mismatch")
    if digest_bytes(raw) != descriptor.get("sha256"):
        raise ValueError("sha256_mismatch")
    return raw


def image_decode_ok(raw: bytes) -> bool:
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.verify()
        return True
    except Exception:
        return False


def parse_hash(metadata: dict[str, Any], content: bytes, pages: bytes) -> str:
    value = {
        "parserKey": metadata.get("parserKey"),
        "parseAttemptId": metadata.get("parseAttemptId"),
        "contentSha256": digest_bytes(content),
        "pagesSha256": digest_bytes(pages),
    }
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return digest_bytes(encoded)


def run(project: Path, output: Path) -> dict[str, Any]:
    project = project.resolve()
    source_root = (project / "data/invoices/voxel51").resolve()
    quality_root = (project / "agent-eval/data").resolve()
    output = output.resolve()
    if output.is_relative_to(quality_root):
        raise ValueError("output_must_not_be_inside_active_quality_data")
    if output.exists():
        raise ValueError("refusing_to_overwrite_existing_output")
    output.parent.mkdir(parents=True, exist_ok=True)

    started = datetime.now(timezone.utc)
    manifest_path = source_root / "manifest.json"
    manifest_raw = manifest_path.read_bytes()
    manifest = json.loads(manifest_raw)
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("samples"), list):
        raise ValueError("unsupported_source_manifest")

    errors: list[dict[str, str]] = []
    source_records: dict[str, list[str]] = defaultdict(list)
    originals: dict[str, set[str]] = defaultdict(set)
    counters = {
        "samples": len(manifest["samples"]),
        "metadataChecked": 0,
        "sourceFilesChecked": 0,
        "parseArraysChecked": 0,
        "parsePairsValid": 0,
        "imageDescriptors": 0,
        "imageRefs": 0,
        "imageRefsResolved": 0,
        "imageBytesDecoded": 0,
        "imageDecodeFailures": 0,
        "sampleIdentityMatches": 0,
        "originalDigestMatches": 0,
    }

    def record(sample_id: str, code: str, detail: str = "") -> None:
        if len(errors) < 100:
            item = {"sampleId": sample_id, "code": code}
            if detail:
                item["detail"] = detail
            errors.append(item)

    for sample in manifest["samples"]:
        sample_id = str(sample.get("sampleId", ""))
        original_sha = str(sample.get("originalSha256", ""))
        try:
            metadata_desc = sample["metadata"]
            metadata_path = source_root / str(metadata_desc["path"])
            metadata_raw = descriptor_check(metadata_path, metadata_desc)
            counters["metadataChecked"] += 1
            metadata = json.loads(metadata_raw)
            if metadata.get("sampleId") != sample_id:
                record(sample_id, "SAMPLE_ID_MISMATCH")
            else:
                counters["sampleIdentityMatches"] += 1
            if metadata.get("originalSha256") != original_sha:
                record(sample_id, "ORIGINAL_DIGEST_MISMATCH")
            else:
                counters["originalDigestMatches"] += 1
            source_record = metadata.get("sourceRecordId")
            if not isinstance(source_record, str) or not source_record.strip():
                record(sample_id, "SOURCE_RECORD_ID_MISSING")
            else:
                source_records[source_record].append(sample_id)

            descriptors = metadata.get("files")
            if not isinstance(descriptors, list):
                record(sample_id, "FILES_SCHEMA_INVALID")
                continue
            by_path: dict[str, tuple[dict[str, Any], bytes]] = {}
            for descriptor in descriptors:
                path = str(descriptor.get("path", ""))
                raw = descriptor_check(source_root / sample_id / path, descriptor)
                counters["sourceFilesChecked"] += 1
                by_path[path] = (descriptor, raw)
                if path.lower().endswith(IMAGE_SUFFIXES):
                    counters["imageDescriptors"] += 1
                    if image_decode_ok(raw):
                        counters["imageBytesDecoded"] += 1
                    else:
                        counters["imageDecodeFailures"] += 1
                        record(sample_id, "IMAGE_DECODE_FAILED", path)

            content_pair = by_path.get("content.json")
            pages_pair = by_path.get("pages.json")
            if content_pair is None or pages_pair is None:
                record(sample_id, "PARSE_FILES_MISSING")
                continue
            content = json.loads(content_pair[1])
            pages = json.loads(pages_pair[1])
            counters["parseArraysChecked"] += 1
            if not isinstance(content, list) or not isinstance(pages, list) or not content or not pages:
                record(sample_id, "PARSE_ARRAY_EMPTY_OR_INVALID")
                continue
            page_numbers: set[int] = set()
            page_counts: dict[int, int] = {}
            for page in pages:
                number = page.get("pageNumber") if isinstance(page, dict) else None
                if not isinstance(number, int) or number < 1 or number in page_numbers:
                    record(sample_id, "PAGE_SEQUENCE_INVALID")
                    continue
                page_numbers.add(number)
                page_counts[number] = 0
            for block in content:
                if not isinstance(block, dict):
                    record(sample_id, "BLOCK_SCHEMA_INVALID")
                    continue
                page_idx = block.get("page_idx")
                if not isinstance(page_idx, int) or page_idx + 1 not in page_numbers:
                    record(sample_id, "BLOCK_PAGE_MISMATCH")
                else:
                    page_counts[page_idx + 1] += 1
                image_ref = block.get("img_path", block.get("image_path"))
                if image_ref is not None:
                    counters["imageRefs"] += 1
                    if isinstance(image_ref, str) and image_ref in by_path and image_ref.lower().endswith(IMAGE_SUFFIXES):
                        counters["imageRefsResolved"] += 1
                    else:
                        record(sample_id, "IMAGE_REFERENCE_UNRESOLVED", str(image_ref))
            for page in pages:
                if isinstance(page, dict) and page.get("blockCount") is not None and page.get("blockCount") != page_counts.get(page.get("pageNumber")):
                    record(sample_id, "PAGE_BLOCK_COUNT_MISMATCH")
            if not any(item.get("sampleId") == sample_id for item in errors):
                counters["parsePairsValid"] += 1

            try:
                p_hash = parse_hash(metadata, content_pair[1], pages_pair[1])
                originals[original_sha].add(p_hash)
            except Exception:
                record(sample_id, "PARSE_HASH_FAILED")
        except Exception as exc:
            record(sample_id, "SOURCE_CHECK_FAILED", type(exc).__name__)

    duplicate_source_records = {key: sorted(value) for key, value in source_records.items() if len(value) > 1}
    variant_groups = {
        key: sorted(value)
        for key, value in originals.items()
        if len(value) > 1
    }
    ended = datetime.now(timezone.utc)
    report: dict[str, Any] = {
        "schemaVersion": VERSION,
        "checkedAt": ended.isoformat().replace("+00:00", "Z"),
        "sourceManifestSha256": digest_bytes(manifest_raw),
        "sourceModified": False,
        "counters": counters,
        "sourceRecordId": {
            "unique": len(source_records),
            "duplicateGroups": len(duplicate_source_records),
            "duplicates": duplicate_source_records,
        },
        "parseVariants": {
            "originalGroups": len(originals),
            "multipleParseGroups": len(variant_groups),
            "groups": variant_groups,
        },
        "imageClosure": {
            "status": "PASS" if counters["imageRefs"] == counters["imageRefsResolved"] and counters["imageDecodeFailures"] == 0 else "FAIL",
            "referenced": counters["imageRefs"],
            "resolved": counters["imageRefsResolved"],
            "descriptorDecodeFailures": counters["imageDecodeFailures"],
        },
        "semanticPairing": {
            "status": "NOT_ESTABLISHED",
            "structuralIdentityChecks": ["manifest.sampleId↔metadata.sampleId", "manifest.originalSha256↔metadata.originalSha256", "sourceRecordId presence/uniqueness", "page/block correspondence", "image reference closure"],
            "businessMeaningChecks": ["original invoice text/image agrees with parsed fields", "same invoice identity is semantically confirmed", "OCR/parser field correctness"],
            "humanVerifiedGold": 0,
            "reason": "No human or independently authorized semantic annotation was present; machine structure cannot establish business truth.",
        },
        "errors": errors,
        "errorCount": len(errors),
        "status": "PASS_STRUCTURAL_ONLY" if not errors else "FAIL",
        "window": {"startedAt": started.isoformat().replace("+00:00", "Z"), "endedAt": ended.isoformat().replace("+00:00", "Z")},
    }
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = run(args.project, args.output)
    print(json.dumps({"status": report["status"], "counters": report["counters"], "errorCount": report["errorCount"], "semanticPairing": report["semanticPairing"]["status"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
