import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { createKimiDesktop } from '../../apps/desktop/main/kimi-desktop.ts';
import { connectKimiMcp } from '../../apps/desktop/main/kimi-mcp.ts';

const root = process.env.FLOWMATE_KIMICU_PLUGIN_ROOT, runtime = process.env.KIMI_CU_WINDOWS_EXE;
test.skipIf(process.platform !== 'win32' || !root || !runtime)('KimiCU can observe and fill a controlled sample field', async () => {
  const app = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'),
    args: [resolve('tests/desktop/fixtures/kimi-sample.cjs')] });
  const session = await connectKimiMcp(root!, runtime!), desktop = createKimiDesktop(session.api);
  try {
    const page = await app.firstWindow();
    await page.locator('#amount').waitFor();
    const signal = new AbortController().signal, owner = { workId: 1, itemId: 1 };
    const listed = await desktop.listWindows(signal); if (!listed.ok) throw Error(listed.error.code);
    const targetWindow = listed.data.find(value => value.title === 'Flowmate KimiCU Controlled Sample');
    expect(targetWindow).toBeDefined(); if (!targetWindow) return;
    expect((await desktop.select(owner, targetWindow, signal)).ok).toBe(true);
    let observed = await desktop.observe(owner, signal); if (!observed.ok) throw Error(observed.error.code);
    let line = observed.data.tree.split('\n').find(value => /\[\d+\].*编辑.*sample amount/i.test(value));
    for (let attempt = 0; !line && attempt < 5; attempt++) {
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
      observed = await desktop.observe(owner, signal); if (!observed.ok) throw Error(observed.error.code);
      line = observed.data.tree.split('\n').find(value => /\[\d+\].*编辑.*sample amount/i.test(value));
    }
    expect(line).toBeDefined();
    const index = line?.match(/\[(\d+)\]/)?.[1]; if (!index) throw Error('sample_control_missing');
    const action = { kind: 'set_value' as const, observationId: observed.data.observationId, elementIndex: Number(index), value: '113.00' };
    const target = await desktop.resolveTarget(owner, action, signal); if (!target.ok) throw Error(target.error.code);
    expect(await desktop.dispatch(owner, action, target.data, signal)).toEqual({ ok: true, data: undefined });
    expect(await page.locator('#amount').inputValue()).toBe('113.00');
    await page.evaluate(() => {
      const field = document.createElement('input');
      field.type = 'password';
      field.setAttribute('aria-label', 'Sample Password');
      field.value = 'synthetic-only';
      document.querySelector('main')!.append(field);
      field.focus();
    });
    let protectedObservation = await desktop.observe(owner, signal);
    for (let attempt = 0; protectedObservation.ok && attempt < 5; attempt++) {
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
      protectedObservation = await desktop.observe(owner, signal);
    }
    expect(protectedObservation).toMatchObject({ ok: false, error: { code: 'desktop_protected_content' } });
    expect(await desktop.dispatch(owner, { ...action, value: '999.00' }, target.data, signal)).toMatchObject({ ok: false });
    expect(await page.locator('#amount').inputValue()).toBe('113.00');
  } finally { await desktop.close(); await app.close(); }
}, 30000);
