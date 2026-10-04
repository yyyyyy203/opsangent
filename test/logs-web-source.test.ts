import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Clock, IdGenerator } from '../src/contracts/index.js';
import type { Tool, ToolResponse } from '../src/contracts/index.js';
import type { RuntimeToolPorts } from '../src/application/create-runtime.js';
import { createInspectionRuntime } from '../src/bootstrap/inspection-runtime.js';
import { createLogsWebSource } from '../src/bootstrap/logs-web-source.js';
import { stableSourceChildRunId } from '../src/bootstrap/source-subagent-identity.js';
import { ScriptedModel } from '../src/model/scripted-model.js';
import { RecordingObservability } from './fixtures/recording-observability.js';

const roots: string[] = [];
const cursorSecret = '0123456789abcdef0123456789abcdef';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

describe('Web Logs source composition', () => {
  it('fails closed if any runtime-owned Logs evidence data-plane port is absent', async () => {
    const captured = await capturePorts(false);
    try {
      const options = { mcpUrl: 'http://127.0.0.1:19211/mcp', model: new ScriptedModel([]), cursorSecret };
      expect(() => createLogsWebSource(omitPort(captured.ports, 'evidenceBlobs'), options)).toThrow(/data plane/i);
      expect(() => createLogsWebSource(omitPort(captured.ports, 'evidenceManifests'), options)).toThrow(/data plane/i);
      expect(() => createLogsWebSource(omitPort(captured.ports, 'streamingEvidenceRecorder'), options)).toThrow(/data plane/i);
    } finally {
      await captured.close();
    }
  });

  it('exposes one parent tool, reuses runtime-owned ports, validates cursor key strength, and connects lazily', async () => {
    const captured = await capturePorts(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => (
      Promise.reject(new Error('Logs MCP must not be contacted during Web bootstrap.'))
    ));
    try {
      const tools = createLogsWebSource(captured.ports, {
        mcpUrl: 'http://127.0.0.1:19211/mcp',
        model: new ScriptedModel([]),
        cursorSecret,
      });

      expect(tools.map((tool) => tool.name)).toEqual(['logs_subagent']);
      expect(captured.runtime.toolkit.get('logs.capture')).toBeUndefined();
      expect(captured.ports.checkpoints).toBe(captured.runtime.checkpoints);
      expect(captured.ports.evidence).toBe(captured.runtime.evidence);
      expect(captured.ports.evidenceBlobs).toBe(captured.runtime.evidenceBlobs);
      expect(captured.ports.evidenceManifests).toBe(captured.runtime.evidenceManifests);
      expect(captured.ports.streamingEvidenceRecorder).toBe(captured.runtime.streamingEvidenceRecorder);
      expect(captured.ports.sharedEvents).toBe(captured.runtime.sharedEvents);
      expect(captured.ports.sharedEvents.events).toBe(captured.ports.events);
      expect(captured.ports.sharedEvents.store).toBe(captured.runtime.eventStoreV2);
      expect(captured.ports.sharedEvents.source).toBe(captured.runtime.eventPublisherV2);
      expect(captured.ports.clock).toBe(captured.clock);
      expect(captured.ports.ids).toBe(captured.ids);
      expect(fetchSpy).not.toHaveBeenCalled();

      expect(() => createLogsWebSource(captured.ports, {
        mcpUrl: 'http://127.0.0.1:19211/mcp', model: new ScriptedModel([]), cursorSecret: 'short-key',
      })).toThrow(/cursor secret/i);
      expect(() => createLogsWebSource(captured.ports, {
        mcpUrl: 'http://127.0.0.1:19211/mcp', model: new ScriptedModel([]), cursorSecret: ' '.repeat(32),
      })).toThrow(/cursor secret/i);
    } finally {
      await captured.close();
    }
  });

  it('runs a Logs child on the shared Checkpoint and V2 event stores and rejects cross-source hints or oversized questions', async () => {
    const captured = await capturePorts(true);
    try {
      const logsTool = createLogsWebSource(captured.ports, {
        mcpUrl: 'http://127.0.0.1:19211/mcp',
        model: new ScriptedModel([{ text: '暂未执行查询', toolCalls: [] }]),
        cursorSecret,
      })[0];
      if (logsTool === undefined) throw new Error('Logs parent Tool missing');
      const input = {
        profileId: 'simulation', service: 'checkout',
        start: '2026-10-04T11:55:00.000Z', end: '2026-10-04T12:00:00.000Z',
        question: '检查结算日志',
      };
      const childRunId = stableSourceChildRunId('logs', 'parent-run-1', 'parent-tool-1');
      const response = await drainTool(logsTool, input, 'parent-run-1');
      expect(await captured.ports.checkpoints.load(childRunId)).not.toBeNull();
      expect(await captured.ports.sharedEvents.store.readRun(childRunId, 0, 100)).not.toHaveLength(0);
      expect(response.blocks.some((block) => block.type === 'json')).toBe(true);

      await expect(drainTool(logsTool, { ...input, evidenceIds: ['metrics-evidence-1'] }, 'parent-run-2'))
        .rejects.toMatchObject({ code: 'POLICY_DENIED' });
      await expect(drainTool(logsTool, { ...input, question: '界'.repeat(683) }, 'parent-run-3'))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    } finally {
      await captured.close();
    }
  });

  it('passes an explicit child model identity into the shared Logs child runtime', async () => {
    const exporter = new RecordingObservability();
    const captured = await capturePorts(true, exporter);
    const childRunId = stableSourceChildRunId('logs', 'logs-parent-run', 'parent-tool-1');
    try {
      const logsTool = createLogsWebSource(captured.ports, {
        mcpUrl: 'http://127.0.0.1:1/mcp',
        model: new ScriptedModel([{ text: '不请求来源数据。', toolCalls: [] }]),
        cursorSecret,
        modelIdentity: { provider: 'logs-provider', model: 'logs-child-model' },
      })[0];
      if (logsTool === undefined) throw new Error('Logs parent Tool missing');

      await drainTool(logsTool, {
        profileId: 'simulation', service: 'checkout',
        start: '2026-10-04T11:55:00.000Z', end: '2026-10-04T12:00:00.000Z',
        question: '检查结算日志',
      }, 'logs-parent-run');

      const modelSpan = exporter.starts.find((span) => span.runId === childRunId && span.kind === 'llm');
      expect(modelSpan).toMatchObject({
        name: 'model.logs-child-model',
        attributes: { provider: 'logs-provider', model: 'logs-child-model' },
      });
    } finally {
      await captured.close();
    }
  });
});

async function capturePorts(withLogsDataPlane: boolean, observability?: RecordingObservability): Promise<{
  root: string;
  runtime: ReturnType<typeof createInspectionRuntime>;
  ports: RuntimeToolPorts;
  clock: Clock;
  ids: IdGenerator;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'opsangent-logs-source-'));
  roots.push(root);
  let ports: RuntimeToolPorts | undefined;
  const clock: Clock = { now: () => new Date('2026-10-04T12:00:00.000Z') };
  let sequence = 0;
  const ids: IdGenerator = { next: (prefix) => `${prefix}-test-${++sequence}` };
  const runtime = createInspectionRuntime({
    model: new ScriptedModel([]),
    workspaceRoots: [],
    allowedToolNames: [],
    sqlitePath: join(root, 'agent.sqlite'),
    ...(withLogsDataPlane ? { evidenceBlobRootPath: join(root, 'evidence-blobs') } : {}),
    clock,
    ids,
    ...(observability === undefined ? {} : { eventObservability: observability }),
    toolFactories: [(value) => { ports = value; return []; }],
  });
  try {
    await runtime.ready;
    if (ports === undefined) throw new Error('runtime did not create the tool-factory ports');
    return {
      root, runtime, ports, clock, ids,
      close: async () => {
        await runtime.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function omitPort<Key extends keyof RuntimeToolPorts>(ports: RuntimeToolPorts, key: Key): Omit<RuntimeToolPorts, Key> {
  const { [key]: omitted, ...remaining } = ports;
  void omitted;
  return remaining;
}

async function drainTool(tool: Tool, input: Record<string, unknown>, runId: string): Promise<ToolResponse> {
  const returned = tool.call?.(input, {
    toolCallId: 'parent-tool-1', runId, stepId: 'step-1', profileId: 'simulation',
    signal: new AbortController().signal, mode: 'dry_run', remainingToolCalls: 8,
  });
  if (returned === undefined || typeof returned !== 'object' || !(Symbol.asyncIterator in returned)) {
    throw new Error('expected Logs Subagent streaming Tool');
  }
  const stream = returned as AsyncGenerator<unknown, ToolResponse>;
  while (true) {
    const item = await stream.next();
    if (item.done) return item.value;
  }
}
