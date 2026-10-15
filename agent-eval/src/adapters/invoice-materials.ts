import { decodeFile } from '../dataset-loader/flat.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readVoxel51Files } from '../../../packages/data/src/source/voxel51.ts';
import { parseVoxel51Sample } from '../../../packages/data/src/parsed-document.ts';
import { caseMaterialSchema } from '../dataset-loader/schema.ts';
import type { AgentTrial } from './agent.ts';

export type SelectedInvoice = { sample: string; files: Array<{ name: string; bytes: Uint8Array }> };

/** Read only selected prepared samples, binding every imported document byte to the authorized projection. */
export function readInvoiceInputs(trial: AgentTrial): SelectedInvoice[] {
    if (!trial.invoiceSource) throw new Error('Invoice source registration is missing');
    const all = z.array(caseMaterialSchema).min(1).parse(trial.invoiceSource.materials);
    const refs = all.filter(ref => ref.source === 'voxel51');
    const visible = trial.input.materials;
    if (all.length !== visible.length || new Set(all.map(m => m.sample + '/' + m.file)).size !== all.length ||
        new Set(visible.map(m => m.sample + '/' + m.file)).size !== visible.length)
        throw new Error('Invoice source projection is not one-to-one');
    return [...new Set(refs.map(m => m.sample))].map(sample => {
        const selected = refs.filter(m => m.sample === sample);
        if (selected.length !== 2 || !selected.some(m => m.file === 'content.json') || !selected.some(m => m.file === 'pages.json'))
            throw new Error('Invoice import requires explicitly declared content.json and pages.json');
        const source = readVoxel51Files(join(trial.invoiceSource!.root, sample), trial.directory, undefined, trial.invoiceSource!.root);
        if (!source.ok) throw new Error('Invoice source: ' + source.error.code);
        const parsed = parseVoxel51Sample(source.data);
        if (!parsed.ok) throw new Error('Invoice source: ' + parsed.error.code);
        const files = [{ name: source.data.originalFileName, bytes: source.data.originalBytes },
            { name: 'content.json', bytes: source.data.contentBytes }, { name: 'pages.json', bytes: source.data.pagesBytes },
            { name: 'metadata.json', bytes: source.data.metadataBytes }];
        for(const file of files){const declared=trial.invoiceSource!.files?.find(f=>['invoice-input/','voxel51/'].some(prefix=>f.path===prefix+sample+'/'+file.name));
            if(!declared||!Buffer.from(file.bytes).equals(decodeFile(declared).bytes))throw Error('Invoice bytes differ from declared source contents');}
        for (const ref of selected) {
            const file = files.find(f => f.name === ref.file)!;
            const projection = visible.find(m => m.sample === sample && m.file === ref.file);
            if (!projection ||
                new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.bytes) !== projection.text)
                throw new Error('Invoice bytes differ from declared source or visible projection');
        }
        return { sample, files };
    });
}

export function writeInvoiceInputs(root: string, invoices: SelectedInvoice[]) {
    mkdirSync(root);
    const files: Array<{ path: string }> = [];
    for (const invoice of invoices) {
        if (!/^\d{6}$/.test(invoice.sample) || invoice.files.length !== 4 ||
            invoice.files.map(f => f.name).sort().join(',') !== ['content.json', 'metadata.json', 'pages.json',
                invoice.files.some(f => f.name === 'original.jpg') ? 'original.jpg' : 'original.png'].sort().join(','))
            throw new Error('Invoice package contains undeclared files');
        const directory = join(root, invoice.sample); mkdirSync(directory);
        for (const file of invoice.files) {
            writeFileSync(join(directory, file.name), file.bytes, { flag: 'wx' });
            files.push({ path: 'invoice-input/' + invoice.sample + '/' + file.name });
        }
    }
    return files;
}
