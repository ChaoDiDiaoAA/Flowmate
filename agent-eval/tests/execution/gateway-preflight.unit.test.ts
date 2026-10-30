import { expect, test } from 'bun:test';
import { preflightBenchmarkGateway } from '../../src/execution/benchmark.ts';

test('gateway preflight only reads metadata and refuses missing model roles before execution', async () => {
  const requests: string[] = [];
  const models = ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6.1-terra'];
  await preflightBenchmarkGateway('http://127.0.0.1:8767/v1', models, async (url, init) => {
    requests.push(url); expect(init.method).toBe('GET');
    return Response.json(url.endsWith('/health') ? { status: 'ok' } : { data: models.map(id => ({ id })) });
  });
  expect(requests).toEqual(['http://127.0.0.1:8767/health', 'http://127.0.0.1:8767/v1/models']);
  await expect(preflightBenchmarkGateway('http://127.0.0.1:8767/v1', models,
    async url => Response.json(url.endsWith('/health') ? { status: 'ok' } : { data: [{ id: models[0] }] }))).rejects.toThrow('missing');
});
