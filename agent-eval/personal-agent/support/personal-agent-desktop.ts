import type { Page } from 'playwright';
import { expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from '../../../tests/support/resources.ts';
export { stream } from './personal-agent-stream.ts';

export const root = resolve(import.meta.dirname, '../../..');
export function environment(userData: string) {
  const env: Record<string, string> = { FLOWMATE_TEST_MODE: '1', FLOWMATE_TEST_USER_DATA_ROOT: userData };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'WINDIR', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA'])
    if (process.env[key]) env[key] = process.env[key]!;
  return env;
}
export function mixedInvoiceBlocks(index: number) {
  const buyer = index <= 7 ? 'Buyer Example ' + index : index <= 10 ? 'Buyer name unreadable in the controlled source' : 'Buyer Alpha';
  return ['Invoice MIX-' + index, 'Issued 2026-10-29', 'Seller Example Seller ' + index, buyer, 'Currency CNY', 'Net 100.00', 'Tax 13.00', 'Total 113.00',
    ...(index > 10 ? ['Buyer Beta'] : [])].map((text, offset) => ({ id: 'b' + (offset + 1), kind: 'text', text, sourceIndex: offset, sourceType: 'controlled', bbox: null }));
}
export async function seed(mixed = false) {
  const userData = await mkdtemp(join(tmpdir(), 'flowmate-personal-ui-'));
  const processResult = spawnSync(process.env.FLOWMATE_BUN_EXECUTABLE || 'bun', ['--no-env-file', '-e', `
    import { createFileStore,openDatabase } from '@flowmate/core'; import { resolveProductPaths } from '@flowmate/shared';
    const input=JSON.parse(await Bun.stdin.text()), paths=resolveProductPaths(input.root); if(!paths.ok) throw Error(paths.error.code);
    const opened=openDatabase(paths.data); if(!opened.ok) throw Error(opened.error.code);
    try { const files=createFileStore(paths.data,opened.data), at='2026-10-29T00:00:00.000Z';
      for(let index=1;index<=input.count;index++) { const blocks=input.mixedBlocks?.[index-1]??[{id:'b1',kind:'text',text:'Total 113.00',sourceIndex:0,sourceType:'controlled',bbox:null}];
        const parsed={formatVersion:2,pages:[{page:1,blocks}],completeness:{status:'complete',checks:[],warnings:[]}};
        const published=await files.publish({sourceKey:'voxel51-hq-invoice-ocr',sourceRecordId:'p18-ui-'+index,sourceVersion:'p18-ui-v'+index,at,
          original:{kind:'original',primaryName:'original.png',files:[{name:'original.png',bytes:Buffer.from(input.png,'base64'),mimeType:'image/png'}]},
          parsed:{kind:'parsed',primaryName:'parsed.json',files:[{name:'parsed.json',bytes:Buffer.from(JSON.stringify(parsed)),mimeType:'application/json'}]}});
        if(!published.ok) throw Error(published.error.code);
        const registered=await opened.data.transaction(scope=>scope.documents.register({documentId:published.data.documentId,sourceKey:'voxel51-hq-invoice-ocr',sourceRecordId:'p18-ui-'+index,version:'p18-ui-v'+index,
          originalArtifact:published.data.original,parsedArtifact:published.data.parsed,status:'available',metadata:{version:2,sampleId:String(index).padStart(6,'0'),pageCount:1,warnings:[],allowedUsesClaim:['local review'],licenseVerification:'not_verified',unavailableReason:null},createdAt:at,updatedAt:at}));
        if(!registered.ok) throw Error(registered.error.code);
      }
    } finally { await opened.data.close(); }
  `], { cwd: root, input: JSON.stringify({ root: userData, count: mixed ? 12 : 2,
    mixedBlocks: mixed ? Array.from({ length: 12 }, (_, index) => mixedInvoiceBlocks(index + 1)) : null,
    png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a54AAAAASUVORK5CYII=' }),
    encoding: 'utf8', windowsHide: true });
  if (processResult.status !== 0) throw Error('Isolated invoice seed failed: ' + processResult.stderr);
  return userData;
}

export async function configure(page: Page, baseUrl: string) {
  expect(await page.evaluate(async baseUrl => {
    const current = await window.flowmate.getState(); if (!current.ok) return current;
    return window.flowmate.saveSettings({ ...current.data.settings, models: [{ id: 'personal-ui', credentialRef: '00000000000000000000000000000091',
      name: 'Personal fixture', kind: 'custom', providerId: null, baseUrl: baseUrl + '/v1', model: 'personal-ui-model',
      api: 'openai-completions', contextWindow: 64000, maxTokens: 8192, reasoning: false }], defaultModelId: 'personal-ui' },
    { modelId: 'personal-ui', apiKey: 'synthetic-personal-ui-key' });
  }, baseUrl)).toMatchObject({ ok: true });
  await page.getByRole('button', { name: 'Personal Agent', exact: true }).click(); await page.getByRole('button', { name: 'Local workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Personal Agent', exact: true })).toBeVisible();
  const personal = await page.evaluate(() => window.flowmate.personalAgent.get());
  expect(personal, JSON.stringify(personal)).toMatchObject({ ok: true });
  await page.locator('.personal-configuration > summary').click();
  await expect(page.getByLabel('Personal Agent model', { exact: true })).toBeVisible({ timeout: 5000 }).catch(async cause => {
    throw Error(String(cause) + '\nPersonal page: ' + await page.locator('.personal-agent-page').innerText());
  });
  await page.getByLabel('Personal Agent model', { exact: true }).selectOption('personal-ui');
  await page.getByRole('button', { name: 'Save assistant configuration', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Assistant configuration saved');
  await page.locator('.personal-configuration > summary').click();
}
