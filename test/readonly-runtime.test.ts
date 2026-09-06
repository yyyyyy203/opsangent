import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import type { Tool } from '../src/contracts/index.js';

const query: Tool = { name: 'query', description: 'readonly', kind: 'evidence', inputSchema: z.object({}), call: () => ({ blocks: [] }) };
const base = () => ({ model: new ScriptedModel([{ toolCalls: [] }]), workspaceRoots: [], allowedToolNames: ['query'], tools: [query] });
describe('readonly inspection bootstrap', () => {
  it('only exposes approved tools and freezes registration', () => {
    const runtime = createInspectionRuntime(base());
    expect(runtime.toolkit.list().map((tool) => tool.name)).toEqual(['query']);
    expect(() => runtime.toolkit.register({ ...query, name: 'later' })).toThrow();
  });
  it.each([
    { ...query, name: 'bash' },
    { ...query, kind: 'action' as const },
    { name: 'query', description: 'external', kind: 'evidence' as const, inputSchema: z.object({}) },
  ])('rejects dangerous or externally executed tools even on the allowlist', (candidate) => {
    expect(() => createInspectionRuntime({ ...base(), tools: [candidate], allowedToolNames: [candidate.name] })).toThrow();
  });
  it('rejects tools absent from the local allowlist', () => {
    expect(() => createInspectionRuntime({ ...base(), allowedToolNames: [] })).toThrow();
  });
});
