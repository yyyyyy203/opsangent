import { describe, expect, it } from 'vitest';
import { readLangSmithEventConfig } from '../src/bootstrap/langsmith.js';
import * as bootstrap from '../src/bootstrap/index.js';

const enabledEnvironment = {
  LANGSMITH_TRACING: 'true',
  LANGSMITH_API_KEY: 'unit-test-key',
  LANGSMITH_PROJECT: 'inspection-agent-test',
};

describe('LangSmith event configuration', () => {
  it('exports the LangSmith runtime factory from the bootstrap barrel', () => {
    expect(bootstrap.readLangSmithEventConfig).toBe(readLangSmithEventConfig);
    expect(bootstrap.createLangSmithEventObservability).toBeTypeOf('function');
  });

  it('is disabled unless tracing is explicitly enabled', () => {
    expect(readLangSmithEventConfig({})).toEqual({ enabled: false });
    expect(readLangSmithEventConfig({ LANGSMITH_TRACING: 'false' })).toEqual({ enabled: false });
    expect(readLangSmithEventConfig({ LANGSMITH_TRACING: '0' })).toEqual({ enabled: false });
  });

  it('accepts the explicit enable values and applies the default HTTPS endpoint', () => {
    expect(readLangSmithEventConfig(enabledEnvironment)).toEqual({
      enabled: true,
      apiKey: 'unit-test-key',
      projectName: 'inspection-agent-test',
      endpoint: 'https://api.smith.langchain.com',
    });
    expect(readLangSmithEventConfig({ ...enabledEnvironment, LANGSMITH_TRACING: '1' }).enabled).toBe(true);
  });

  it('fails with a fixed error when enabled configuration is incomplete or malformed', () => {
    for (const environment of [
      { ...enabledEnvironment, LANGSMITH_API_KEY: '' },
      { ...enabledEnvironment, LANGSMITH_PROJECT: '' },
      { ...enabledEnvironment, LANGSMITH_TRACING: 'yes' },
      { ...enabledEnvironment, LANGSMITH_ENDPOINT: 'https://user:secret@smith.example' },
      { ...enabledEnvironment, LANGSMITH_ENDPOINT: 'https://smith.example/?secret=canary' },
      { ...enabledEnvironment, LANGSMITH_ENDPOINT: 'http://smith.example' },
    ]) {
      expect(() => readLangSmithEventConfig(environment)).toThrow('LANGSMITH_CONFIG_INVALID');
    }
  });
});
