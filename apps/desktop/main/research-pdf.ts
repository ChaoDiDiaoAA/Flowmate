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
  const marker = (citation: ResearchSentence['citations'][number], showClaim = false) => {
    const number = numbers.get(researchCitationKey(citation));
    if (number !== undefined) return ` <a href="#reference-${number}">[${number}]</a>`;
    if (showClaim) return ` · Claim ${citation.claimId}, evidence index ${citation.evidenceIndex}`;
    throw Error('research_reference_missing');
  };
  const paragraph = (sentences: ResearchSentence[]) => '<p>' + sentences.map(sentence => {
    return escape(sentence.text.trim()) + sentence.citations.map(citation => marker(citation)).join('');
  }).join(' ') + '</p>';
  const section = (name: string, items: string[]) => items.length
    ? `<h2>${name}</h2><ul>${items.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : '';
  const review = report.semanticReview;
  const v2 = review?.policyVersion === 'research-semantic-v2' ? review : undefined;
  const legacyReviewNote = review?.policyVersion === 'research-semantic-v1'
    ? '<p>This v1 receipt does not include saved source context or citation contribution checks.</p>' : '';
  const contextHtml = v2?.context && v2.status !== 'no_findings' ? `<h3>Source context · ${v2.context.mode}</h3>
${v2.context.segments.map(({ sourceSnapshotId, start, end, readStart, readEnd, findings }) => `
<p class="meta">Source snapshot ${sourceSnapshotId} · segment [${start}, ${end}) · read [${readStart}, ${readEnd}) · complete</p>
${findings.map(({ sentenceIndex, kind, locator }) => `<p><a href="#review-sentence-${sentenceIndex + 1}">Sentence ${sentenceIndex + 1}</a> · ${kind} · UTF-16 offsets [${locator.start}, ${locator.end})</p>
<blockquote>${escape(locator.quote)}</blockquote>`).join('') || '<p>No context findings recorded.</p>'}`).join('')}` : '';
  const receiptHtml = v2 && v2.status !== 'no_findings' ? contextHtml
    + section('Reviewed evidence bindings', (v2.evidenceBindings ?? []).map(({ claimId, evidenceIndex, ref, source }) =>
      `Claim ${claimId}, evidence index ${evidenceIndex} · ${source.title} · Source snapshot ${source.sourceSnapshotId} · Run ${source.runId} / ToolCall ${source.toolCallId} · UTF-16 offsets [${ref.locator.start}, ${ref.locator.end})`))
    + section('Review stages', (v2.stages ?? []).map(({ stage, model, responseId, usage, tokens }) =>
      `${stage} · ${model.provider} / ${model.model} · Response ${responseId ?? 'unknown'} · Usage ${usage.source} (${usage.attempts ?? 'unknown'} attempts) · Tokens (input / output / total) ${tokens.inputTokens ?? 'unknown'} / ${tokens.outputTokens ?? 'unknown'} / ${tokens.totalTokens ?? 'unknown'} · ${tokens.usageComplete ? 'complete' : 'incomplete'} · Cost ${tokens.cost ?? 'unknown'}`))
    : legacyReviewNote;
  const reviewHtml = review ? `<h2>Semantic review</h2>
<p class="meta">${escape(review.status.replaceAll('_', ' '))} · Policy ${escape(review.policyVersion)} · Run ${review.runId} / ToolCall ${review.toolCallId}${review.status !== 'no_findings' ? ` · Model ${escape(review.model.provider)} / ${escape(review.model.model)}` : ''} · ${escape(review.reviewedAt)}</p>
${review.status === 'no_findings' ? '<p>No findings to review. No review model was called.</p>' : ''}
${review.sentences.map(row => `<h3 id="review-sentence-${row.sentenceIndex + 1}">Sentence ${row.sentenceIndex + 1} · ${escape(row.verdict.replaceAll('_', ' '))} · ${row.complete ? 'complete' : 'incomplete'}</h3>
<p>${escape(row.text)}</p>
<ul>${row.facts.map((fact, index) => `<li>Fact ${index + 1}: <strong>${escape(fact.text)}</strong> · ${escape(fact.verdict.replaceAll('_', ' '))} · UTF-16 offsets [${fact.start}, ${fact.end})<br>
${escape(fact.reason)}${fact.citations.map(citation => marker(citation, true)).join('')}</li>`).join('')}</ul>
${v2 && row.citationReviews?.length ? `<p><strong>Citation contributions</strong></p><ul>${row.citationReviews.map(check => `
<li>Claim ${check.claimId}, evidence index ${check.evidenceIndex}${marker(check)} · ${check.verdict}: ${escape(check.reason)}
<ul>${check.contributions.map(item => `<li>Fact ${item.factIndex + 1} · ${item.role.replaceAll('_', ' ')}: ${escape(item.reason)}</li>`).join('')}</ul></li>`).join('')}</ul>` : ''}`).join('')}
${receiptHtml}`
    : '<p class="meta">No independent semantic review for this report.</p>';
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
${reviewHtml}
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
