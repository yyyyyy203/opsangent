import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ChatModel, Clock, IdGenerator, Observability, Tool } from '../contracts/index.js';
import { systemClock, randomIdGenerator } from '../contracts/index.js';
import { createInspectionRuntime } from './inspection-runtime.js';
import { createOpenAICompatibleModel, type CreateOpenAICompatibleModelOptions } from './openai-compatible.js';
import { OpaqueMessageCursorCodec } from '../application/message-cursor-codec.js';
import { WebQueryService, type ConfiguredWebProfile } from '../application/web-query-service.js';
import { RunExecutionCoordinator } from '../application/run-execution-coordinator.js';
import { WebConfirmationService } from '../application/web-confirmation-service.js';
import { startInspectionHttpServer, type InspectionHttpServer } from '../api/http-server.js';

const DEFAULT_PROFILES: readonly AgentWebProfileConfig[] = Object.freeze([{
  id: 'group-buy-market',
  name: 'group-buy-market',
  description: '只读巡检 Profile；数据源和阈值由宿主配置。',
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
  profiles?: readonly AgentWebProfileConfig[];
  host?: string;
  port?: number;
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  clock?: Clock;
  ids?: IdGenerator;
  observability?: Observability;
}

export interface AgentWebRuntime {
  readonly url: string;
  readonly server: InspectionHttpServer;
  close(): Promise<void>;
}

/** Assemble the local-only Agent host. Model credentials never enter HTTP DTOs. */
export async function startAgentWebRuntime(options: AgentWebRuntimeOptions): Promise<AgentWebRuntime> {
  validatePaths(options);
  const host = options.host ?? '127.0.0.1';
  validateLocalHost(host);
  await mkdir(options.dataDirectory, { recursive: true });

  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? randomIdGenerator;
  const model = resolveModel(options);
  const profiles = normalizeProfiles(options.profiles ?? DEFAULT_PROFILES);
  const allowedToolNames = (options.tools ?? []).map((tool) => tool.name);
  const runtime = createInspectionRuntime({
    model,
    workspaceRoots: [...options.workspaceRoots],
    tools: [...(options.tools ?? [])],
    allowedToolNames,
    sqlitePath: join(options.dataDirectory, 'agent.sqlite'),
    clock,
    ids,
    ...(options.observability === undefined ? {} : { observability: options.observability }),
  });

  try {
    await runtime.ready;
    if (runtime.durableState === undefined || runtime.queries === undefined) {
      throw new Error('Agent web runtime requires durable SQLite queries and checkpoints.');
    }
    const cursorCodec = new OpaqueMessageCursorCodec(() => clock.now().getTime());
    const webQueries = new WebQueryService(runtime.durableState.checkpoints, profiles, () => clock.now());
    const execution = new RunExecutionCoordinator(runtime.agent, runtime.checkpoints);
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
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          await server.close();
        } finally {
          await runtime.close();
        }
      },
    };
  } catch (error) {
    await runtime.close();
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
