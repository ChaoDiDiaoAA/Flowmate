import { BrowserWindow } from 'electron';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { researchCitationKey } from '@flowmate/contracts';
import type { ResearchReportDocument, ResearchSentence } from '@flowmate/contracts';

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

export function researchPrintHtml(document: ResearchReportDocument): string {
  const { report, title, references } = document;
  if (!report.cited) throw Error('research_pdf_legacy');
  const numbers = new Map(references.map(reference => [researchCitationKey(reference), reference.number]));
  const paragraph = (sentences: ResearchSentence[]) => '<p>' + sentences.map(sentence => {
    const markers = sentence.citations.map(citation => {
      const number = numbers.get(researchCitationKey(citation));
      if (number === undefined) throw Error('research_reference_missing');
      return ` <a href="#reference-${number}">[${number}]</a>`;
    }).join('');
    return escape(sentence.text.trim()) + markers;
  }).join(' ') + '</p>';
  const section = (name: string, items: string[]) => items.length
    ? `<h2>${name}</h2><ul>${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${escape(title)}</title><style>
body{font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:11pt;line-height:1.55;color:#171717;overflow-wrap:anywhere}
h1{font-size:22pt} h2{font-size:15pt;margin-top:1.3em} h3,h2{break-after:avoid}
p,li{widows:2;orphans:2} a{color:#145388} blockquote{margin:.5em 0 1em;padding-left:.8em;border-left:2px solid #757575;white-space:pre-wrap}
.meta{color:#444;font-size:9pt} .refs{break-before:page}
</style></head><body><h1>${escape(title)}</h1>
<p class="meta">Report ${report.reportId} · Plan ${report.planId} rev. ${report.revision} · ${report.completeness} · ${escape(report.createdAt)}</p>
${!report.cited.answer.length && !report.cited.sections.length ? '<p>No citable findings</p>' : ''}
${report.cited.answer.length ? '<h2>Research answer</h2>' + paragraph(report.cited.answer) : ''}
${report.cited.sections.map(item => `<h2>${escape(item.title)}</h2>${paragraph(item.sentences)}`).join('')}
${section('Coverage', report.coverage.map(item => `${item.questionId} · ${item.status} · ${item.reason}`))}
${section('Conflicts', report.conflicts)}${section('Limitations', report.limitations)}${section('Unresolved questions', report.unresolvedQuestions)}
${references.length ? '<h2 class="refs">References</h2>' : ''}
${references.map(({ number, claimId, relation, source, locator }) => `<h3 id="reference-${number}">Reference [${number}]</h3>
<p>${escape(source.title)} · ${escape(source.address)}</p>
<p class="meta">Claim ${claimId} · ${relation} · Source snapshot ${source.sourceSnapshotId} · Run ${source.runId} / ToolCall ${source.toolCallId}<br>
UTF-16 offsets [${locator.start}, ${locator.end}) · Fetched ${escape(source.fetchedAt)} · Source date ${escape(source.publishedAt ?? 'unknown')}</p>
<blockquote>${escape(locator.quote)}</blockquote>`).join('')}</body></html>`;
}

export async function printResearchPdf(document: ResearchReportDocument): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), 'flowmate-research-print-'));
  const file = join(directory, 'report.html');
  let window: BrowserWindow | undefined;
  try {
    await writeFile(file, researchPrintHtml(document), { encoding: 'utf8', flag: 'wx' });
    window = new BrowserWindow({ show: false, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false,
    } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    await window.loadFile(file);
    return await window.webContents.printToPDF({ pageSize: 'A4', printBackground: true });
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    await unlink(file).catch(() => {});
    await rmdir(directory).catch(() => {});
  }
}
