import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveProductPaths, resolveWindowsUserData, validateProductPaths } from '../packages/shared/src/paths.ts';

describe('ProductPaths', () => {
  it('derives the formal Flowmate layout from the final absolute user-data root', () => {
    const result = resolveProductPaths('C:\\Users\\test\\AppData\\Roaming\\Flowmate');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.databaseFile).toBe('C:\\Users\\test\\AppData\\Roaming\\Flowmate\\data\\app.sqlite');
    expect(result.data.root).toBe('C:\\Users\\test\\AppData\\Roaming\\Flowmate');
    expect(result.data.runtimeDir.startsWith(result.data.root)).toBe(true);
  });

  it('uses APPDATA and rejects a missing Windows user-data environment', () => {
    expect(resolveWindowsUserData({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' })).toEqual({
      ok: true,
      data: 'C:\\Users\\test\\AppData\\Roaming\\Flowmate',
    });
    const result = resolveWindowsUserData({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('config_user_data_missing');
  });

  it('treats the resolved Windows user-data directory as the final Flowmate root', () => {
    const userData = resolveWindowsUserData({ APPDATA: 'C:\\Users\\test\\AppData\\Roaming' });
    expect(userData.ok).toBe(true);
    if (!userData.ok) return;
    const result = resolveProductPaths(userData.data);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.root).toBe('C:\\Users\\test\\AppData\\Roaming\\Flowmate');
      expect(result.data.databaseFile).toBe('C:\\Users\\test\\AppData\\Roaming\\Flowmate\\data\\app.sqlite');
    }
  });

  it('[F-path-isolation] rejects a ProductPaths member that escapes the root', async () => {
    const result = await validateProductPaths({
      root: 'C:\\trial',
      databaseFile: 'C:\\trial\\data\\trial.sqlite',
      logsDir: 'C:\\trial\\logs',
      artifactsDir: 'C:\\outside',
      outputsDir: 'C:\\trial\\outputs',
      runtimeDir: 'C:\\trial\\runtime',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('path_outside_root');
  });

  it('[F-path-isolation] rejects an existing junction that resolves outside the trial root', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowmate-path-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'flowmate-path-outside-'));
    mkdirSync(join(root, 'data'));
    mkdirSync(join(root, 'logs'));
    mkdirSync(join(root, 'outputs'));
    mkdirSync(join(root, 'runtime'));
    symlinkSync(outside, join(root, 'artifacts'), 'junction');

    const result = validateProductPaths({
      root,
      databaseFile: join(root, 'data', 'trial-1.sqlite'),
      logsDir: join(root, 'logs'),
      artifactsDir: join(root, 'artifacts'),
      outputsDir: join(root, 'outputs'),
      runtimeDir: join(root, 'runtime'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('path_outside_root');
  });
});
