import { expect, test } from 'bun:test';
import { readCloudConnection, saveCloudConnection } from '../../apps/desktop/renderer/src/cloud-connection-state.ts';

test('saved cloud connection contains only a valid workspace and nonsecret SSH paths', () => {
  const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); } };
  const profile = { workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', target: { host: 'example.test', port: 22,
    username: 'flowmate-bridge', privateKeyPath: 'C:\\keys\\flowmate', knownHostsPath: 'C:\\keys\\known_hosts' } };
  expect(readCloudConnection(storage)).toEqual({ ok: true, data: null });
  expect(saveCloudConnection(storage, profile)).toBe(true);
  expect(readCloudConnection(storage)).toEqual({ ok: true, data: profile });
  expect(saveCloudConnection(storage, { ...profile, target: { ...profile.target, password: 'synthetic' } })).toBe(false);
  expect(readCloudConnection(storage)).toEqual({ ok: true, data: profile });
  const key = [...values.keys()][0]!; values.set(key, '{broken');
  expect(readCloudConnection(storage)).toMatchObject({ ok: false });
  expect(values.get(key)).toBe('{broken');
});
