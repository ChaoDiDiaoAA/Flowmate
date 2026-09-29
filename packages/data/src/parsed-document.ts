import { appError, fail, ok, ParsedBlockSchema } from '@flowmate/contracts';
import type { ParsedBlock, Result } from '@flowmate/contracts';

export const VOXEL51_SOURCE_KEY = 'voxel51-hq-invoice-ocr';

export type ParsedVoxel51Document = {
  formatVersion: 2;
  pages: Array<{ page: number; blocks: ParsedBlock[] }>;
  completeness: { status: 'complete'; checks: string[]; warnings: string[] };
};

export type Voxel51Sample = {
  sourceKey: typeof VOXEL51_SOURCE_KEY;
  sampleId: string;
  sourceRecordId: string;
  datasetRevision: string;
  originalFileName: 'original.jpg' | 'original.png';
  allowedUsesClaim: string[];
  licenseVerification: string;
  parsed: ParsedVoxel51Document;
};

export type Voxel51SampleInput = {
  metadata: unknown;
  content: unknown;
  pages: unknown;
  originalFileName: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringList(value: unknown, max: number): string[] | null {
  return Array.isArray(value) && value.length <= max && value.every((item) => typeof item === 'string' && item.length <= 1024)
    ? value : null;
}

function pageText(value: unknown): string | null {
  const page = record(value);
  if (!page || !Number.isSafeInteger(page.pageNumber) || Number(page.pageNumber) !== 1
    || typeof page.text !== 'string' || !Number.isSafeInteger(page.blockCount) || Number(page.blockCount) < 1) return null;
  return page.text;
}

function annotationText(value: unknown, label: 'Caption' | 'Footnote'): string | null {
  if (value === undefined) return '';
  const texts = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null;
  if (!texts || !texts.every((item) => typeof item === 'string')) return null;
  return texts.map((text) => text ? `${label}: ${text}` : '').filter(Boolean).join('\n\n');
}

function blockText(block: Record<string, unknown>): { kind: ParsedBlock['kind']; text: string } | null {
  const type = block.type;
  if (type === 'text' || type === 'header' || type === 'footer' || type === 'page_footnote' || type === 'page_number') {
    return typeof block.text === 'string' ? { kind: 'text', text: block.text } : null;
  }
  if (type === 'table') {
    if (typeof block.table_body !== 'string') return null;
    const caption = annotationText(block.table_caption, 'Caption');
    const footnote = annotationText(block.table_footnote, 'Footnote');
    if (caption === null || footnote === null) return null;
    return { kind: 'table', text: [caption, block.table_body, footnote]
      .filter(Boolean).join('\n\n') };
  }
  if (type === 'image') {
    const captionValue = block.image_caption === undefined ? block.caption : block.image_caption;
    const footnoteValue = block.image_footnote === undefined ? block.footnote : block.image_footnote;
    const caption = annotationText(captionValue, 'Caption');
    const footnote = annotationText(footnoteValue, 'Footnote');
    if (caption === null || footnote === null) return null;
    return { kind: 'image', text: [caption, footnote]
      .filter(Boolean).join('\n\n') };
  }
  return null;
}

export function parseVoxel51Sample(input: Voxel51SampleInput): Result<Voxel51Sample> {
  const metadata = record(input.metadata);
  const content = input.content;
  const sourceRecordId = metadata?.sourceRecordId;
  const sampleId = metadata?.sampleId;
  const datasetRevision = metadata?.datasetRevision;
  const allowedUsesClaim = stringList(metadata?.allowedUsesClaim, 32);
  const licenseVerification = metadata?.licenseVerification;
  const files = metadata?.files;
  const pageDirectory = Array.isArray(input.pages) && input.pages.length === 1 ? input.pages[0] : null;
  const rawPageText = pageText(pageDirectory);
  const invalid = !metadata || typeof sampleId !== 'string' || !/^\d{6}$/.test(sampleId)
    || typeof sourceRecordId !== 'string' || sourceRecordId.length < 1 || sourceRecordId.length > 512
    || typeof datasetRevision !== 'string' || datasetRevision.length < 1 || datasetRevision.length > 256
    || !allowedUsesClaim || typeof licenseVerification !== 'string' || licenseVerification.length > 1024
    || !Array.isArray(files) || files.length < 3 || files.length > 64
    || typeof metadata.qualityStatus !== 'string' || /partial|blocked|incomplete|failed/i.test(metadata.qualityStatus)
    || !['original.jpg', 'original.png'].includes(input.originalFileName)
    || !Array.isArray(content) || content.length < 1 || content.length > 2_000 || rawPageText === null;
  if (invalid) return fail(appError('source_invalid', 'input', '来源材料结构不完整或不受支持。'));

  const page = record(pageDirectory)!;
  if (Number(page.blockCount) !== content.length) return fail(appError('source_invalid', 'input', '来源页目录与解析块数量不一致。'));
  const blocks: ParsedBlock[] = [];
  for (const [sourceIndex, raw] of content.entries()) {
    const block = record(raw);
    if (!block || block.page_idx !== 0 || !Array.isArray(block.bbox)
      && block.bbox !== null) return fail(appError('source_invalid', 'input', '解析块字段格式无效。'));
    const mapped = blockText(block);
    if (!mapped) return fail(appError('source_invalid', 'input', '来源包含未支持的解析块类型。'));
    let bbox: ParsedBlock['bbox'] = null;
    if (block.bbox !== null) {
      if (block.bbox.length !== 4 || !block.bbox.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        return fail(appError('source_invalid', 'input', '解析块坐标格式无效。'));
      }
      bbox = block.bbox as [number, number, number, number];
    }
    const parsed = ParsedBlockSchema.safeParse({
      id: `b${sourceIndex + 1}`, kind: mapped.kind, text: mapped.text, sourceIndex,
      sourceType: block.type, bbox,
    });
    if (!parsed.success) return fail(appError('source_invalid', 'input', '解析块超出支持范围。'));
    blocks.push(parsed.data);
  }
  if (!rawPageText.trim() && !blocks.some((block) => block.text.trim())) {
    return fail(appError('source_invalid', 'input', '来源解析页为空。'));
  }
  return ok({
    sourceKey: VOXEL51_SOURCE_KEY,
    sampleId: sampleId as string,
    sourceRecordId: sourceRecordId as string,
    datasetRevision: datasetRevision as string,
    originalFileName: input.originalFileName as Voxel51Sample['originalFileName'],
    allowedUsesClaim,
    licenseVerification,
    parsed: {
      formatVersion: 2,
      pages: [{ page: 1, blocks }],
      completeness: { status: 'complete', checks: ['page-sequence', 'block-count', 'supported-blocks'], warnings: [] },
    },
  });
}
