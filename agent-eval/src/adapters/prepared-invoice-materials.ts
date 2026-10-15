import { decodeFile } from '../dataset-loader/flat.ts';
import { readFileSync } from 'node:fs';
import { PreparedInvoiceMaterialSchema, type PreparedInvoiceMaterial } from '../../../packages/contracts/src/invoice.ts';
import { inside } from '../dataset-loader/local.ts';
import type { AgentTrial } from './agent.ts';

export function readPreparedInvoices(trial: AgentTrial) {
    const refs = trial.invoiceSource!.materials, root = trial.invoiceSource!.localRoot ?? trial.invoiceSource!.root;
    const hasVoxel = refs.some(ref => ref.source === 'voxel51');
    const compareLocalVersions = !hasVoxel && refs.filter(ref => ref.source === 'local-text').length > 1;
    const invoices: PreparedInvoiceMaterial[] = [], attachments: AgentTrial['input']['materials'] = [];
    for (const ref of refs) {
        if (ref.source !== 'local-text') continue;
        const prefix = 'materials/' + ref.sample + '/', source = readFileSync(inside(root, prefix + ref.file));
        const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
        const visible = trial.input.materials.find(material => material.sample === ref.sample && material.file === ref.file);
        const original = ref.originalFile ? readFileSync(inside(root, prefix + ref.originalFile)) : source;
        const declared=ref.originalFile?trial.invoiceSource!.files?.find(f=>f.path===prefix+ref.originalFile):undefined;
        if (ref.originalFile&&(!declared||!original.equals(decodeFile(declared).bytes)) || !visible || visible.text !== text)
            throw new Error('Prepared invoice differs from its declared source or visible projection');
        if (hasVoxel) { attachments.push(visible); continue; }
        if (compareLocalVersions) attachments.push(visible);
        const headers = [...text.matchAll(/^## 原件第([1-9]\d*)页（共([1-9]\d*)页）\r?$/gm)];
        if (ref.originalFile && (ref.originalFile !== 'original.pdf' || !headers.length || headers.some((header, index) =>
            Number(header[1]) !== index + 1 || Number(header[2]) !== headers.length))) throw new Error('Prepared PDF requires its declared sequential page boundaries');
        const pages = headers.length ? headers.map((header, index) => text.slice(header.index! + header[0].length, headers[index + 1]?.index ?? text.length)) : [text];
        invoices.push(PreparedInvoiceMaterialSchema.parse({ contract: 'flowmate-prepared-invoice/v1', sample: ref.sample,
            original: { name: ref.originalFile ?? 'source.md', base64: original.toString('base64') }, sourceText: text,
            pages: pages.map((page, index) => ({ page: index + 1, blocks: page.split(/\r?\n/).filter(line => line.trim()).map((line, row) => ({
                id: 'b' + (row + 1), kind: 'text', text: line, sourceIndex: row, sourceType: 'prepared-text', bbox: null })) })) }));
    }
    return { invoices, attachments };
}
