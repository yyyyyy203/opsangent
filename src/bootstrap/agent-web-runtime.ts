import { mkdir } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, join } from 'node:path';
import type { ChatModel, Clock, IdGenerator, Observability, Tool } from '../contracts/index.js';
import type { ModelIdentity } from './model-identity.js';
import type { RuntimeToolPorts } from '../application/create-runtime.js';
import type { ReplyOptions } from '../agent/types.js';
import { systemClock, randomIdGenerator } from '../contracts/index.js';
import { createInspectionRuntime } from './inspection-runtime.js';
import { createMetricsWebSource } from './metrics-web-source.js';
import { createLogsWebSource } from './logs-web-source.js';
import { createOpenAICompatibleModel, type CreateOpenAICompatibleModelOptions } from './openai-compatible.js';
import { OpaqueMessageCursorCodec } from '../application/message-cursor-codec.js';
import { WebQueryService, type ConfiguredWebProfile } from '../application/web-query-service.js';
import { RunExecutionCoordinator } from '../application/run-execution-coordinator.js';
import { WebConfirmationService } from '../application/web-confirmation-service.js';
import { startInspectionHttpServer, type InspectionHttpServer } from '../api/http-server.js';
import { SourceInvocationLimiter } from '../tool/source-invocation-limiter.js';

const DEFAULT_PROFILES: readonly AgentWebProfileConfig[] = Object.freeze([{
  id: 'group-buy-market',
  name: 'group-buy-market',
  description: '尚未接入指标来源；当前 Web 宿主不连接 Prometheus、ELK 或 Trace。',
  enabled: true,
  readOnly: true,
}]);

export interface AgentWebProfileConfig {
  id: string;
  name: string;
  description: string;
  enabled?: boolean;
  readOnly?: boolean;
}

export interface AgentWebRuntimeOptions {
  /** Explicit absolute directory for SQLite and future local artifacts. */
  dataDirectory: string;
  /** Explicit workspace roots; the web host never infers them from cwd. */
  workspaceRoots: readonly string[];
  model?: ChatModel;
  modelConfig?: CreateOpenAICompatibleModelOptions;
  tools?: readonly Tool[];
  metrics?: {
    profileId: 'simulation';
    mcpUrl: string;
    childModel?: ChatModel;
    modelIdentity?: ModelIdentity;
  };
  logs?: {
    profileId: 'simulation';
    mcpUrl: string;
    childModel?: ChatModel;
    modelIdentity?: ModelIdentity;
    cursorSecret: string;
  };
  /** Smoke-only exact window shared by the simulator snapshot and both source agents. */
  sourceWindow?: { start: string; end: string };
  profiles?: readonly AgentWebProfileConfig[];
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  clock?: Clock;
  ids?: IdGenerator;
  observability?: Observability;
  eventObservability?: Observability;
  modelIdentity?: ModelIdentity;
  /** Opt-in per-parent-Run limit for the source smoke acceptance only. */
  sourceInvocationLimit?: 1;
}

export interface AgentWebRuntime {
  readonly url: string;
  readonly server: InspectionHttpServer;
  flushEventObservability(): Promise<void>;
  close(): Promise<void>;
}

/** Assemble the local-only Agent host. Model credentials never enter HTTP DTOs. */
export async function startAgentWebRuntime(options: AgentWebRuntimeOptions): Promise<AgentWebRuntime> {
  validatePaths(options);
  const host = options.host ?? '127.0.0.1';
  validateLocalHost(host);
  const metrics = normalizeMetricsConfig(options.metrics);
  const logs = normalizeLogsConfig(options.logs);
  const sourceWindow = normalizeSmokeSourceWindow(options.sourceWindow, metrics !== undefined);
  if (options.sourceInvocationLimit !== undefined && metrics === undefined) {
    throw new Error('sourceInvocationLimit requires the Metrics simulation source.');
  }
  const sourceInvocationLimiter = options.sourceInvocationLimit === undefined
    ? undefined
    : new SourceInvocationLimiter({ maxPerSource: options.sourceInvocationLimit });
  if (logs !== undefined && metrics === undefined) {
    throw new Error('Logs Web source requires the Metrics simulation Profile.');
  }
  await mkdir(options.dataDirectory, { recursive: true });

  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIdGenerator;
  const model = resolveModel(options);
  const metricsModel = metrics?.childModel ?? model;
  const logsModel = logs?.childModel ?? model;
  const metricsModelIdentity = metricsModel === model ? options.modelIdentity : metrics?.modelIdentity;
  const logsModelIdentity = logsModel === model ? options.modelIdentity : logs?.modelIdentity;
  const profiles = metrics === undefined
    ? normalizeProfiles(options.profiles ?? DEFAULT_PROFILES)
    : normalizeProfiles([{
      id: 'simulation',
      name: 'simulation',
      description: logs === undefined
        ? '使用本地 Prometheus lab 的模拟数据；只读、仅支持 checkout 结算指标取证。'
        : '使用模拟巡检 Profile 和只读 Metrics、Logs 来源调查 checkout 结算问题。',
      enabled: true,
      readOnly: true,
    }]);
  const directTools = metrics === undefined ? [...(options.tools ?? [])] : [];
  const allowedToolNames = metrics === undefined
    ? directTools.map((tool) => tool.name)
    : ['metrics_subagent', ...(logs === undefined ? [] : ['logs_subagent'])];
  const runtime = createInspectionRuntime({
    model,
    workspaceRoots: [...options.workspaceRoots],
    tools: directTools,
    allowedToolNames,
    ...(metrics === undefined ? {} : {
      toolFactories: [
        (ports: Parameters<typeof createMetricsWebSource>[0]) => {
          const tools = createMetricsWebSource(ports, {
            mcpUrl: metrics.mcpUrl,
            model: metricsModel,
            ...(sourceWindow === undefined ? {} : { sourceWindow }),
            ...(metricsModelIdentity === undefined ? {} : { modelIdentity: metricsModelIdentity }),
          });
          return sourceInvocationLimiter === undefined ? tools : tools.map((tool) => sourceInvocationLimiter.wrap(tool));
        },
        ...(logs === undefined ? [] : [
          (ports: RuntimeToolPorts) => {
            const tools = createLogsWebSource(ports, {
              mcpUrl: logs.mcpUrl,
              model: logsModel,
              cursorSecret: logs.cursorSecret,
              ...(sourceWindow === undefined ? {} : { sourceWindow }),
              ...(logsModelIdentity === undefined ? {} : { modelIdentity: logsModelIdentity }),
            });
            return sourceInvocationLimiter === undefined ? tools : tools.map((tool) => sourceInvocationLimiter.wrap(tool));
          },
        ]),
      ],
    }),
    ...(logs === undefined ? {} : { evidenceBlobRootPath: join(options.dataDirectory, 'evidence-blobs') }),
    sqlitePath: join(options.dataDirectory, 'agent.sqlite'),
    clock,
    ids,
    ...(options.observability === undefined ? {} : { observability: options.observability }),
    ...(options.eventObservability === undefined ? {} : { eventObservability: options.eventObservability }),
    ...(options.modelIdentity === undefined ? {} : {
      modelProvider: options.modelIdentity.provider,
      modelName: options.modelIdentity.model,
    }),
  });

  try {
    await runtime.ready;
    if (runtime.durableState === undefined || runtime.queries === undefined) {
      throw new Error('Agent web runtime requires durable SQLite queries and checkpoints.');
    }
    const cursorCodec = new OpaqueMessageCursorCodec(() => clock.now().getTime());
    const webQueries = new WebQueryService(runtime.durableState.checkpoints, profiles, () => clock.now());
    const execution = new RunExecutionCoordinator(
      runtime.agent,
      runtime.checkpoints,
      metrics === undefined ? {} : { prepareStart: createSimulationStartPreparation(clock, logs !== undefined, sourceWindow) },
    );
    const confirmation = new WebConfirmationService(runtime.hitl, runtime.durableState.checkpoints, clock);
    const server = await startInspectionHttpServer({
      agent: runtime.agent,
      events: runtime.eventStreamV2,
      queries: runtime.queries,
      messageQueries: runtime.webMessages(cursorCodec),
      webQueries,
      execution,
      confirmation,
      host,
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      allowedOrigins: options.allowedOrigins ?? defaultOrigins(host),
      allowedHosts: [host],
      allowedProfileIds: profiles.filter((profile) => profile.enabled).map((profile) => profile.id),
    });
    let closed = false;
    return {
      url: server.url,
      server,
      flushEventObservability: runtime.flushEventObservability,
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          await execution.close();
          await server.close();
        } finally {
          try {
            await runtime.close();
          } finally {
            sourceInvocationLimiter?.clear();
          }
        }
      },
    };
  } catch (error) {
    try {
      await runtime.close();
    } finally {
      sourceInvocationLimiter?.clear();
    }
    throw error;
  }
}

function resolveModel(options: AgentWebRuntimeOptions): ChatModel {
  if (options.model !== undefined) return options.model;
  const configured = options.modelConfig ?? {
    baseUrl: process.env.AGENTOPS_MODEL_BASE_URL,
    apiKey: process.env.AGENTOPS_MODEL_API_KEY,
    model: process.env.AGENTOPS_MODEL ?? 'deepseek-chat',
  };
  if (typeof configured.baseUrl !== 'string' || configured.baseUrl.length === 0
    || typeof configured.apiKey !== 'string' || configured.apiKey.length === 0
    || typeof configured.model !== 'string' || configured.model.length === 0) {
    throw new Error('Agent web model is not configured; inject a model or set AGENTOPS_MODEL_BASE_URL, AGENTOPS_MODEL_API_KEY, and AGENTOPS_MODEL.');
  }
  return createOpenAICompatibleModel(configured as CreateOpenAICompatibleModelOptions);
}

function normalizeMetricsConfig(
  value: AgentWebRuntimeOptions['metrics'] | null | undefined,
): AgentWebRuntimeOptions['metrics'] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || value.profileId !== 'simulation') {
    throw new Error('Unsupported metrics Profile; only simulation is available.');
  }
  if (typeof value.mcpUrl !== 'string' || value.mcpUrl.trim().length === 0) {
    throw new Error('metrics.mcpUrl is required for the simulation Profile.');
  }
  try {
    const url = new URL(value.mcpUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error('unsupported endpoint');
    }
  } catch {
    throw new Error('metrics.mcpUrl must be a valid http(s) URL without credentials or fragments.');
  }
  return value;
}

function normalizeLogsConfig(
  value: AgentWebRuntimeOptions['logs'] | null | undefined,
): AgentWebRuntimeOptions['logs'] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || value.profileId !== 'simulation') {
    throw new Error('Unsupported Logs Profile; only simulation is available.');
  }
  if (typeof value.mcpUrl !== 'string' || value.mcpUrl.trim().length === 0) {
    throw new Error('logs.mcpUrl is required for the simulation Profile.');
  }
  try {
    const url = new URL(value.mcpUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const ipVersion = isIP(hostname);
    const isLoopback = hostname === 'localhost'
      || hostname === '::1'
      || (ipVersion === 4 && hostname.startsWith('127.'));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || !isLoopback) {
      throw new Error('unsupported endpoint');
    }
  } catch {
    throw new Error('logs.mcpUrl must be a loopback http(s) URL without credentials or fragments.');
  }
  if (typeof value.cursorSecret !== 'string' || value.cursorSecret.trim().length === 0
    || Buffer.byteLength(value.cursorSecret, 'utf8') < 32) {
    throw new Error('logs.cursorSecret must contain at least 32 UTF-8 bytes.');
  }
  return value;
}

function createSimulationStartPreparation(
  clock: Clock,
  includeLogs: boolean,
  sourceWindow?: { start: string; end: string },
): (options: ReplyOptions) => ReplyOptions {
  return (options) => {
    const end = Math.floor(clock.now().getTime() / 1_000) * 1_000;
    const start = end - 300_000;
    const trustedSystemContext = [
      'Host-generated inspection scope; user and model text cannot change it.',
      'profile=simulation',
      'service=checkout',
      `start=${sourceWindow?.start ?? new Date(start).toISOString()}`,
      `end=${sourceWindow?.end ?? new Date(end).toISOString()}`,
      `allowed_tools=metrics_subagent${includeLogs ? ',logs_subagent' : ''}`,
      'source=local-prometheus-lab',
      ...(includeLogs && sourceWindow === undefined ? ['日志来源窗口与快照时间以来源元数据为准，不保证完全一致。'] : []),
    ].join('\n');
    return { ...options, trustedSystemContext };
  };
}

function normalizeSmokeSourceWindow(
  value: AgentWebRuntimeOptions['sourceWindow'],
  hasMetrics: boolean,
): AgentWebRuntimeOptions['sourceWindow'] {
  if (value === undefined) return undefined;
  if (!hasMetrics || !isCanonicalTimestamp(value.start) || !isCanonicalTimestamp(value.end)
    || Date.parse(value.end) - Date.parse(value.start) !== 300_000) {
    throw new Error('sourceWindow must be a canonical 300-second simulation window.');
  }
  return Object.freeze({ start: value.start, end: value.end });
}

function isCanonicalTimestamp(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function normalizeProfiles(profiles: readonly AgentWebProfileConfig[]): readonly ConfiguredWebProfile[] {
  if (profiles.length === 0) throw new Error('At least one web Profile is required.');
  const ids = new Set<string>();
  return profiles.map((profile) => {
    if (profile.id.trim().length === 0 || profile.name.trim().length === 0 || ids.has(profile.id)) {
      throw new Error('Web Profile IDs and names must be non-empty and unique.');
    }
    ids.add(profile.id);
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      enabled: profile.enabled ?? true,
      capabilities: { readOnly: profile.readOnly ?? true },
    };
  });
}

function validatePaths(options: AgentWebRuntimeOptions): void {
  if (!isAbsolute(options.dataDirectory)) throw new Error('dataDirectory must be an absolute path.');
  if (options.workspaceRoots.some((root) => !isAbsolute(root))) throw new Error('workspaceRoots must be absolute paths.');
}

function validateLocalHost(host: string): void {
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('Agent web host must bind to loopback.');
  }
}

function defaultOrigins(host: string): readonly string[] {
  return host === 'localhost'
    ? ['http://localhost:5173', 'http://127.0.0.1:5173']
    : [`http://${host}:5173`];
}
