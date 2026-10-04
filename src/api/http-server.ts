import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { DiagnosisAgent, ReplyOptions } from '../agent/types.js';
import type { InspectionQueryService, RunListOptions } from '../contracts/read-model.js';
import type { RunStatus } from '../contracts/context.js';
import type { PublicConfirmation, PublicProfile, WebMessageQueries } from '../contracts/web-read-model.js';
import { encodeSseFrame } from './sse-encoder.js';
import { EventStreamCursorError, type EventStreamService } from './event-stream-service.js';
import type { RunExecutionCoordinator } from '../application/run-execution-coordinator.js';
import type { WebConfirmationDecisionInput, WebConfirmationService } from '../application/web-confirmation-service.js';

export interface InspectionHttpServerOptions {
  agent: DiagnosisAgent;
  events: EventStreamService;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  queries?: InspectionQueryService;
  messageQueries?: WebMessageQueries;
  webQueries?: { listProfiles(): readonly PublicProfile[]; getConfirmation(runId: string): Promise<PublicConfirmation | null> };
  execution?: RunExecutionCoordinator;
  confirmation?: Pick<WebConfirmationService, 'decide'>;
  allowedOrigins?: readonly string[];
  allowedHosts?: readonly string[];
  allowedProfileIds?: readonly string[];
  heartbeatTimer?: {
    set(callback: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

export interface InspectionHttpServer {
  host: string;
  port: number;
  url: string;
  server: Server;
  close(): Promise<void>;
}

/** Small Node 20 transport adapter; domain execution remains in DiagnosisAgent/EventStreamService. */
export async function startInspectionHttpServer(options: InspectionHttpServerOptions): Promise<InspectionHttpServer> {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 0;
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError('port must be between 0 and 65535');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) throw new RangeError('maxBodyBytes must be positive');

  const shutdown = new AbortController();
  const server = createServer((request, response) => {
    void handleRequest(request, response, options, maxBodyBytes, shutdown.signal).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      const clientVisible = status >= 400 && status < 500;
      writeJson(response, status, {
        error: errorCode(error, status, clientVisible),
        message: clientVisible ? (error instanceof Error ? error.message : 'Invalid request.') : status === 503 ? 'Run query service is unavailable.' : 'Internal server error.',
      });
    });
  });
  await listen(server, port, host);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP server did not expose a TCP address.');
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    server,
    close: () => {
      shutdown.abort();
      return close(server);
    },
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: InspectionHttpServerOptions, maxBodyBytes: number, shutdownSignal: AbortSignal): Promise<void> {
  const method = request.method ?? 'GET';
  const parsed = new URL(request.url ?? '/', 'http://localhost');
  if (!applyHost(request, response, options.allowedHosts)) return;
  if (!applyCors(request, response, options.allowedOrigins)) return;
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (method === 'GET' && parsed.pathname === '/health') { writeJson(response, 200, { status: 'ok' }); return; }
  if (method === 'GET' && parsed.pathname === '/profiles') {
    if (options.webQueries === undefined) throw unavailable();
    writeJson(response, 200, options.webQueries.listProfiles());
    return;
  }

  const eventMatch = method === 'GET' ? /^\/runs\/([^/]+)\/events$/u.exec(parsed.pathname) : null;
  const headerLastEventId = request.headers['last-event-id'];
  const lastEventId = typeof headerLastEventId === 'string' ? headerLastEventId : parsed.searchParams.get('lastEventId') ?? undefined;
  if (eventMatch?.[1] !== undefined) {
    const snapshots = parsed.searchParams.getAll('snapshots');
    if (snapshots.length > 1 || (snapshots[0] !== undefined && snapshots[0] !== 'none')) {
      throw Object.assign(new Error('snapshots must be none.'), { statusCode: 400 });
    }
    const runId = decodePath(eventMatch[1]);
    const queries = requireQueries(options.queries);
    if (await queries.getRun(runId) === null) {
      writeJson(response, 404, { error: 'NOT_FOUND', message: 'Run not found.' });
      return;
    }
    await streamEvents(request, response, options.events, runId, lastEventId, snapshots[0] !== 'none', options.heartbeatTimer, shutdownSignal);
    return;
  }

  if (method === 'POST' && parsed.pathname === '/runs') {
    const body = await readJson(request, maxBodyBytes);
    const run = toReplyOptions(body);
    if (options.allowedProfileIds !== undefined && !options.allowedProfileIds.includes(run.profileId)) {
      throw Object.assign(new Error('profileId is not enabled.'), { code: 'PROFILE_NOT_ALLOWED', statusCode: 400 });
    }
    const runId = run.runId ?? randomUUID();
    const requestOptions = { ...run, runId };
    if (options.execution === undefined) void consume(options.agent.replyStream(requestOptions));
    else void options.execution.start(requestOptions).catch(() => undefined);
    writeJson(response, 202, { runId, status: 'started', eventsUrl: `/runs/${encodeURIComponent(runId)}/events` });
    return;
  }

  const cancelMatch = method === 'POST' ? /^\/runs\/([^/]+)\/cancel$/u.exec(parsed.pathname) : null;
  if (cancelMatch?.[1] !== undefined) {
    if (options.execution === undefined) throw unavailable();
    const runId = decodePath(cancelMatch[1]);
    await options.execution.cancel(runId);
    writeJson(response, 202, { runId, status: 'cancelling' });
    return;
  }

  const resumeMatch = method === 'POST' ? /^\/runs\/([^/]+)\/resume$/u.exec(parsed.pathname) : null;
  if (resumeMatch?.[1] !== undefined) {
    const runId = decodePath(resumeMatch[1]);
    if (options.execution === undefined) void consume(options.agent.resumeStream(runId));
    else void options.execution.resume(runId).catch(() => undefined);
    writeJson(response, 202, { runId, status: 'resuming', eventsUrl: `/runs/${encodeURIComponent(runId)}/events` });
    return;
  }

  if (method === 'GET' && parsed.pathname === '/runs') {
    const queries = requireQueries(options.queries);
    const query: RunListOptions = {
      ...(parsed.searchParams.get('profileId') === null ? {} : { profileId: parsed.searchParams.get('profileId')! }),
      ...(parsed.searchParams.get('status') === null ? {} : { status: parseRunStatus(parsed.searchParams.get('status')!) }),
      ...(parsed.searchParams.get('cursor') === null ? {} : { cursor: parsed.searchParams.get('cursor')! }),
      ...(parsed.searchParams.get('limit') === null ? {} : { limit: parsePageLimit(parsed.searchParams.get('limit')!, 'limit') }),
    };
    writeJson(response, 200, await queries.listRuns(query));
    return;
  }

  const messagesMatch = method === 'GET' ? /^\/runs\/([^/]+)\/messages$/u.exec(parsed.pathname) : null;
  if (messagesMatch?.[1] !== undefined) {
    if (options.messageQueries === undefined) throw unavailable();
    const queries = requireQueries(options.queries);
    const runId = decodePath(messagesMatch[1]);
    if (await queries.getRun(runId) === null) { writeJson(response, 404, { error: 'NOT_FOUND', message: 'Run not found.' }); return; }
    const rawLimit = parsed.searchParams.get('limit');
    const limit = rawLimit === null ? 20 : parseWebPageLimit(rawLimit);
    const cursor = parsed.searchParams.get('cursor') ?? undefined;
    try {
      const page = await options.messageQueries.listMessages(runId, { limit, ...(cursor === undefined ? {} : { cursor }) });
      writeJson(response, 200, page);
    } catch (error) {
      if (error instanceof RangeError) throw Object.assign(new Error(error.message), { statusCode: 400 });
      throw error;
    }
    return;
  }

  const confirmationCommandMatch = method === 'POST' ? /^\/runs\/([^/]+)\/confirmation$/u.exec(parsed.pathname) : null;
  if (confirmationCommandMatch?.[1] !== undefined) {
    if (options.confirmation === undefined) throw unavailable();
    const body = await readJson(request, maxBodyBytes);
    const result = await options.confirmation.decide(decodePath(confirmationCommandMatch[1]), toConfirmationInput(body));
    writeJson(response, 200, result);
    return;
  }

  const confirmationMatch = method === 'GET' ? /^\/runs\/([^/]+)\/confirmation$/u.exec(parsed.pathname) : null;
  if (confirmationMatch?.[1] !== undefined) {
    if (options.webQueries === undefined) throw unavailable();
    const runId = decodePath(confirmationMatch[1]);
    const confirmation = await options.webQueries.getConfirmation(runId);
    writeJson(response, 200, confirmation);
    return;
  }

  const evidenceDetailMatch = method === 'GET'
    ? /^\/runs\/([^/]+)\/evidence\/([^/]+)$/u.exec(parsed.pathname)
    : null;
  if (evidenceDetailMatch?.[1] !== undefined && evidenceDetailMatch[2] !== undefined) {
    const queries = requireQueries(options.queries);
    const runId = decodePath(evidenceDetailMatch[1]);
    const evidenceId = decodePath(evidenceDetailMatch[2]);
    const evidence = await queries.getEvidence(runId, evidenceId);
    if (evidence === null) { writeJson(response, 404, { error: 'NOT_FOUND', message: 'Evidence not found.' }); return; }
    writeJson(response, 200, evidence);
    return;
  }

  const evidenceListMatch = method === 'GET' ? /^\/runs\/([^/]+)\/evidence$/u.exec(parsed.pathname) : null;
  if (evidenceListMatch?.[1] !== undefined) {
    const queries = requireQueries(options.queries);
    const runId = decodePath(evidenceListMatch[1]);
    if (await queries.getRun(runId) === null) { writeJson(response, 404, { error: 'NOT_FOUND', message: 'Run not found.' }); return; }
    const result = await queries.listEvidence(runId, {
      ...(parsed.searchParams.get('cursor') === null ? {} : { cursor: parsed.searchParams.get('cursor')! }),
      ...(parsed.searchParams.get('limit') === null ? {} : { limit: parsePageLimit(parsed.searchParams.get('limit')!, 'limit') }),
    });
    writeJson(response, 200, result);
    return;
  }

  const runDetailMatch = method === 'GET' ? /^\/runs\/([^/]+)$/u.exec(parsed.pathname) : null;
  if (runDetailMatch?.[1] !== undefined) {
    const queries = requireQueries(options.queries);
    const run = await queries.getRun(decodePath(runDetailMatch[1]));
    if (run === null) { writeJson(response, 404, { error: 'NOT_FOUND', message: 'Run not found.' }); return; }
    writeJson(response, 200, run);
    return;
  }
  writeJson(response, 404, { error: 'NOT_FOUND', message: 'Route not found.' });
}

export async function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  events: EventStreamService,
  runId: string,
  lastEventId: string | undefined,
  includeMessageSnapshot = true,
  heartbeatTimer: InspectionHttpServerOptions['heartbeatTimer'] = {
    set: (callback, ms) => setInterval(callback, ms),
    clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  },
  shutdownSignal?: AbortSignal,
): Promise<void> {
  try {
    await events.validateCursor(runId, lastEventId);
  } catch (error) {
    if (error instanceof EventStreamCursorError) throw Object.assign(new Error('Event stream cursor is invalid.'), { statusCode: 400 });
    throw error;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.on('aborted', abort);
  response.on('close', abort);
  shutdownSignal?.addEventListener('abort', abort, { once: true });
  if (shutdownSignal?.aborted) abort();
  const socket = response.socket;
  const iterator = events.open({ runId, signal: controller.signal, includeMessageSnapshot, ...(lastEventId === undefined ? {} : { lastEventId }) });
  let heartbeat: unknown;
  let heartbeatPending = false;
  const write = async (data: string): Promise<boolean> => {
    if (controller.signal.aborted || response.destroyed || response.writableEnded) return false;
    if (response.write(data)) return true;
    return new Promise<boolean>((resolve) => {
      const done = (ready: boolean): void => {
        response.off('drain', onDrain);
        controller.signal.removeEventListener('abort', onAbort);
        resolve(ready);
      };
      const onDrain = () => done(!controller.signal.aborted && !response.destroyed);
      const onAbort = () => done(false);
      response.once('drain', onDrain);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted || response.destroyed) onAbort();
    });
  };
  try {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    heartbeat = heartbeatTimer.set(() => {
      if (heartbeatPending || controller.signal.aborted) return;
      heartbeatPending = true;
      void write(': heartbeat\n\n').finally(() => { heartbeatPending = false; });
    }, 15_000);
    for await (const frame of iterator) {
      if (controller.signal.aborted || response.destroyed) break;
      if (!await write(encodeSseFrame(frame))) break;
    }
  } finally {
    abort();
    if (heartbeat !== undefined) heartbeatTimer.clear(heartbeat);
    await iterator.return?.(undefined);
    request.off('aborted', abort);
    response.off('close', abort);
    shutdownSignal?.removeEventListener('abort', abort);
    if (!response.writableEnded) response.end();
    // Ending an SSE response can leave its keep-alive socket open and block server.close().
    if (shutdownSignal?.aborted) socket?.destroy();
  }
}

function requireQueries(value: InspectionQueryService | undefined): InspectionQueryService {
  if (value === undefined) throw unavailable();
  return value;
}

function unavailable(): Error { return Object.assign(new Error('Run query service is unavailable.'), { statusCode: 503 }); }

function parseWebPageLimit(value: string): number {
  if (!/^\d+$/u.test(value)) throw Object.assign(new Error('limit must be a positive integer.'), { statusCode: 400 });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 50) throw Object.assign(new Error('limit must be between 1 and 50.'), { statusCode: 400 });
  return parsed;
}

function parsePageLimit(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) throw Object.assign(new Error(`${name} must be a positive integer.`), { statusCode: 400 });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100) throw Object.assign(new Error(`${name} must be between 1 and 100.`), { statusCode: 400 });
  return parsed;
}

function parseRunStatus(value: string): RunStatus {
  if (!['running', 'awaiting_confirmation', 'paused', 'completed', 'failed', 'cancelled'].includes(value)) {
    throw Object.assign(new Error('status is invalid.'), { statusCode: 400 });
  }
  return value as RunStatus;
}

function applyCors(request: IncomingMessage, response: ServerResponse, allowedOrigins: readonly string[] | undefined): boolean {
  const origin = request.headers.origin;
  if (origin !== undefined && allowedOrigins !== undefined && !allowedOrigins.includes(origin)) {
    writeJson(response, 403, { error: 'FORBIDDEN_ORIGIN', message: 'Origin is not allowed.' });
    return false;
  }
  if (origin !== undefined && allowedOrigins !== undefined) response.setHeader('Access-Control-Allow-Origin', origin);
  else if (allowedOrigins === undefined) response.setHeader('Access-Control-Allow-Origin', '*');
  if (allowedOrigins !== undefined) response.setHeader('Vary', 'Origin');
  return true;
}

function applyHost(request: IncomingMessage, response: ServerResponse, allowedHosts: readonly string[] | undefined): boolean {
  if (allowedHosts === undefined) return true;
  const actual = request.headers.host?.toLowerCase();
  if (actual !== undefined && allowedHosts.some((allowed) => hostMatches(actual, allowed.toLowerCase()))) return true;
  writeJson(response, 403, { error: 'FORBIDDEN_HOST', message: 'Host is not allowed.' });
  return false;
}

function hostMatches(actual: string, allowed: string): boolean {
  return actual === allowed || actual.startsWith(`${allowed}:`);
}

async function consume(stream: AsyncGenerator<unknown, unknown>): Promise<void> {
  try { for await (const event of stream) { void event; /* transport is intentionally detached; clients use SSE */ } }
  catch { /* the Harness emits RUN_FAILED; background execution must not become an unhandled rejection */ }
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: string[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw Object.assign(new Error('Request body too large.'), { statusCode: 413 });
    chunks.push(buffer.toString('utf8'));
  }
  let value: unknown;
  try { value = JSON.parse(chunks.join('')); }
  catch { throw Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 });
  return value as Record<string, unknown>;
}

function toReplyOptions(body: Record<string, unknown>): ReplyOptions {
  if (typeof body.message !== 'string' || body.message.length === 0) throw Object.assign(new Error('message is required.'), { statusCode: 400 });
  if (typeof body.profileId !== 'string' || body.profileId.length === 0) throw Object.assign(new Error('profileId is required.'), { statusCode: 400 });
  const result: ReplyOptions = { message: body.message, profileId: body.profileId };
  if (typeof body.runId === 'string') result.runId = body.runId;
  if (typeof body.maxIterations === 'number') result.maxIterations = body.maxIterations;
  if (typeof body.maxToolCalls === 'number') result.maxToolCalls = body.maxToolCalls;
  if (typeof body.maxDurationMs === 'number') result.maxDurationMs = body.maxDurationMs;
  return result;
}

function toConfirmationInput(body: Record<string, unknown>): WebConfirmationDecisionInput {
  if (typeof body.toolCallId !== 'string' || body.toolCallId.length === 0) {
    throw Object.assign(new Error('toolCallId is required.'), { statusCode: 400 });
  }
  if (typeof body.confirmed !== 'boolean') {
    throw Object.assign(new Error('confirmed must be a boolean.'), { statusCode: 400 });
  }
  if (typeof body.expectedRevision !== 'number' || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
    throw Object.assign(new Error('expectedRevision must be a non-negative integer.'), { statusCode: 400 });
  }
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 2_000)) {
    throw Object.assign(new Error('reason must be a string no longer than 2000 characters.'), { statusCode: 400 });
  }
  return {
    toolCallId: body.toolCallId,
    confirmed: body.confirmed,
    expectedRevision: body.expectedRevision,
    ...(body.reason === undefined ? {} : { reason: body.reason }),
  };
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

function errorCode(error: unknown, status: number, clientVisible: boolean): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return status === 500 ? 'INTERNAL_ERROR' : status === 503 ? 'QUERY_UNAVAILABLE' : status === 404 ? 'NOT_FOUND' : clientVisible ? 'INVALID_REQUEST' : 'REQUEST_FAILED';
}

function decodePath(value: string): string {
  try { return decodeURIComponent(value); }
  catch { throw Object.assign(new Error('Invalid URL path.'), { statusCode: 400 }); }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
