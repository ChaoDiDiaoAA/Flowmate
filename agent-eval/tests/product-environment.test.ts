import { describe, expect, test } from 'bun:test';
import { productChildArguments, productChildEnvironment } from '../src/adapters/product-process.ts';

describe('evaluation product process environment', () => {
  test('disables Bun automatic .env loading for the product child', () => {
    expect(productChildArguments('product-server.ts')).toEqual(['--no-env-file', 'run', 'product-server.ts']);
  });

  test('removes LLM and Langfuse credentials before a Fixture child starts', () => {
    const child = productChildEnvironment({
      FLOWMATE_LLM_API_KEY: 'fixture-must-not-receive-this',
      FLOWMATE_LLM_BASE_URL: 'https://llm.example.com/v1',
      FLOWMATE_LLM_MODEL: 'invoice-model',
      FLOWMATE_LLM_API: 'openai-completions',
      LANGFUSE_SECRET_KEY: 'langfuse-secret',
      LANGFUSE_PUBLIC_KEY: 'langfuse-public',
      LANGFUSE_BASE_URL: 'http://localhost:3000',
    }, 'fixture');

    expect(child.FLOWMATE_LLM_API_KEY).toBeUndefined();
    expect(child.FLOWMATE_LLM_BASE_URL).toBeUndefined();
    expect(child.LANGFUSE_SECRET_KEY).toBeUndefined();
  });

  test('keeps only the live LLM settings for a Live child process', () => {
    const child = productChildEnvironment({
      FLOWMATE_LLM_API_KEY: 'live-key',
      FLOWMATE_LLM_BASE_URL: 'https://llm.example.com/v1',
      FLOWMATE_LLM_MODEL: 'invoice-model',
      FLOWMATE_LLM_API: 'openai-completions',
      LANGFUSE_SECRET_KEY: 'langfuse-secret',
    }, 'live');

    expect(child.FLOWMATE_LLM_API_KEY).toBe('live-key');
    expect(child.FLOWMATE_LLM_MODEL).toBe('invoice-model');
    expect(child.LANGFUSE_SECRET_KEY).toBeUndefined();
  });
});
