import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVoxel51Sample } from '../packages/data/src/parsed-document.ts';
import { readVoxel51Files } from '../packages/data/src/source/voxel51.ts';

type SampleStatus = 'included' | 'reused' | 'rejected' | 'conflict';
type SampleResult = { sampleId: string; status: SampleStatus; reason: string | null };
export type InvoiceInputReport = {
  schemaVersion: 1;
  generatedAt: string;
  sourceRoot: string;
  targetRoot: string;
  totalSamples: number;
  counts: Record<SampleStatus, number>;
  rootConflicts: string[];
  samples: SampleResult[];
};

export type PrepareInvoiceInputOptions = {
  sourceRoot: string;
  targetRoot: string;
  reportPath: string;
  now?: () => string;
};

type PreparedSample = { files: Array<{ name: string; bytes: Uint8Array }> };

function within(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsoluteRelative(rel));
}

function isAbsoluteRelative(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

function plainDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
}

function plainFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch { return false; }
}

function prepareSample(sourceDirectory: string, sampleId: string, targetRoot: string): PreparedSample {
  const source = readVoxel51Files(sourceDirectory, targetRoot);
  if (!source.ok) throw new Error(`${source.error.code}: ${source.error.message}`);
  const metadata = source.data.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('metadata_invalid');
  const record = metadata as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.sampleId !== sampleId
    || typeof record.datasetId !== 'string' || record.datasetId.length < 1 || record.datasetId.length > 256) {
    throw new Error('metadata_identity_invalid');
  }
  const parsed = parseVoxel51Sample({ metadata, content: source.data.content, pages: source.data.pages,
    originalFileName: source.data.originalFileName });
  if (!parsed.ok) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);

  const files = [
    { name: source.data.originalFileName, bytes: source.data.originalBytes },
    { name: 'content.json', bytes: source.data.contentBytes },
    { name: 'pages.json', bytes: source.data.pagesBytes },
  ];
  const preparedMetadata = {
    schemaVersion: record.schemaVersion,
    sampleId: record.sampleId,
    datasetId: record.datasetId,
    sourceRecordId: parsed.data.sourceRecordId,
    datasetRevision: parsed.data.datasetRevision,
    qualityStatus: record.qualityStatus,
    allowedUsesClaim: parsed.data.allowedUsesClaim,
    licenseVerification: parsed.data.licenseVerification,
    files: files.map((file) => ({ path: file.name, bytes: file.bytes.byteLength })),
  };
  return { files: [...files, { name: 'metadata.json', bytes: Buffer.from(`${JSON.stringify(preparedMetadata, null, 2)}\n`, 'utf8') }] };
}

function matchesPreparedDirectory(path: string, files: PreparedSample['files']): { matches: boolean; reason: string | null } {
  if (!plainDirectory(path)) return { matches: false, reason: 'target_sample_not_plain_directory' };
  const expected = files.map((file) => file.name).sort();
  const actual = readdirSync(path).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    return { matches: false, reason: 'target_file_set_conflict' };
  }
  for (const file of files) {
    const targetFile = join(path, file.name);
    if (!plainFile(targetFile)) return { matches: false, reason: `target_file_invalid:${file.name}` };
    if (!Buffer.from(readFileSync(targetFile)).equals(Buffer.from(file.bytes))) {
      return { matches: false, reason: `target_content_conflict:${file.name}` };
    }
  }
  return { matches: true, reason: null };
}

function writeAtomicReport(reportPath: string, report: InvoiceInputReport): void {
  const parent = dirname(reportPath);
  mkdirSync(parent, { recursive: true });
  if (plainDirectory(reportPath) || (() => { try { return lstatSync(reportPath).isSymbolicLink(); } catch { return false; } })()) {
    throw new Error('report_path_invalid');
  }
  const temporaryDirectory = mkdtempSync(join(parent, `.${basename(reportPath)}-`));
  try {
    const temporaryFile = join(temporaryDirectory, basename(reportPath));
    writeFileSync(temporaryFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporaryFile, reportPath);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function prepareInvoiceInput(options: PrepareInvoiceInputOptions): InvoiceInputReport {
  const sourceRoot = resolve(options.sourceRoot);
  const targetRoot = resolve(options.targetRoot);
  const reportPath = resolve(options.reportPath);
  if (!plainDirectory(sourceRoot) || within(sourceRoot, targetRoot) || within(targetRoot, sourceRoot)
    || within(targetRoot, reportPath) || within(sourceRoot, reportPath)) throw new Error('input_roots_invalid');
  if (plainDirectory(targetRoot) === false) {
    try {
      const existing = lstatSync(targetRoot);
      if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('target_root_invalid');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        mkdirSync(targetRoot, { recursive: true });
      } else throw error;
    }
  }
  if (!plainDirectory(targetRoot)) throw new Error('target_root_invalid');
  const targetRealRoot = resolve(targetRoot);
  const entries = readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));
  const sourceIds = new Set(entries.map((entry) => entry.name));
  const results: SampleResult[] = [];

  for (const entry of entries) {
    const sampleId = entry.name;
    if (!/^\d{6}$/.test(sampleId)) {
      results.push({ sampleId, status: 'rejected', reason: 'sample_id_must_be_six_digits' });
      continue;
    }
    if (entry.isSymbolicLink()) {
      results.push({ sampleId, status: 'rejected', reason: 'source_sample_is_symbolic_link' });
      continue;
    }
    let prepared: PreparedSample;
    try { prepared = prepareSample(join(sourceRoot, sampleId), sampleId, targetRealRoot); }
    catch (error) {
      results.push({ sampleId, status: 'rejected', reason: error instanceof Error ? error.message : 'source_invalid' });
      continue;
    }

    const targetSample = join(targetRealRoot, sampleId);
    try {
      const existing = lstatSync(targetSample);
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        results.push({ sampleId, status: 'conflict', reason: 'target_sample_not_plain_directory' });
        continue;
      }
      const match = matchesPreparedDirectory(targetSample, prepared.files);
      results.push(match.matches
        ? { sampleId, status: 'reused', reason: null }
        : { sampleId, status: 'conflict', reason: match.reason });
      continue;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        results.push({ sampleId, status: 'conflict', reason: 'target_sample_unavailable' });
        continue;
      }
    }

    const temporaryDirectory = mkdtempSync(join(targetRealRoot, `.${sampleId}.tmp-`));
    try {
      for (const file of prepared.files) writeFileSync(join(temporaryDirectory, file.name), file.bytes, { flag: 'wx' });
      renameSync(temporaryDirectory, targetSample);
      results.push({ sampleId, status: 'included', reason: null });
    } catch (error) {
      let match: ReturnType<typeof matchesPreparedDirectory> | null = null;
      try { match = matchesPreparedDirectory(targetSample, prepared.files); } catch { /* report the publication failure below */ }
      results.push(match?.matches
        ? { sampleId, status: 'reused', reason: null }
        : { sampleId, status: 'rejected', reason: `publish_failed:${error instanceof Error ? error.message : 'unknown'}` });
    } finally {
      if (plainDirectory(temporaryDirectory) && within(targetRealRoot, temporaryDirectory)) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  const rootConflicts = readdirSync(targetRealRoot, { withFileTypes: true })
    .filter((entry) => !sourceIds.has(entry.name))
    .map((entry) => `unexpected_target_entry:${entry.name}`);
  const counts: InvoiceInputReport['counts'] = { included: 0, reused: 0, rejected: 0, conflict: 0 };
  for (const sample of results) counts[sample.status] += 1;
  const report: InvoiceInputReport = {
    schemaVersion: 1,
    generatedAt: (options.now ?? (() => new Date().toISOString()))(),
    sourceRoot,
    targetRoot,
    totalSamples: entries.length,
    counts,
    rootConflicts,
    samples: results,
  };
  writeAtomicReport(reportPath, report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.cwd());
  const report = prepareInvoiceInput({
    sourceRoot: join(root, 'data', 'invoices', 'voxel51'),
    targetRoot: join(root, 'data', 'invoices', 'agent-input'),
    reportPath: join(root, 'data', 'invoices', 'agent-input-report.json'),
  });
  console.log(JSON.stringify({ reportPath: join(root, 'data', 'invoices', 'agent-input-report.json'),
    totalSamples: report.totalSamples, counts: report.counts, rootConflicts: report.rootConflicts }, null, 2));
  if (report.counts.rejected || report.counts.conflict || report.rootConflicts.length) process.exitCode = 1;
}
