import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { DiagnosisAgent, ReplyOptions } from '../agent/types.js';
import { encodeSseFrame } from './sse-encoder.js';
import type { EventStreamService } from './event-stream-service.js';

export interface InspectionHttpServerOptions {
  agent: DiagnosisAgent;
  events: EventStreamService;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
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

  const server = createServer((request, response) => {
    void handleRequest(request, response, options, maxBodyBytes).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      writeJson(response, status, { error: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Internal server error.' });
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
    close: () => close(server),
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: InspectionHttpServerOptions, maxBodyBytes: number): Promise<void> {
  const method = request.method ?? 'GET';
  const parsed = new URL(request.url ?? '/', 'http://localhost');
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID');
  if (method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (method === 'GET' && parsed.pathname === '/health') { writeJson(response, 200, { status: 'ok' }); return; }

  const eventMatch = method === 'GET' ? /^\/runs\/([^/]+)\/events$/u.exec(parsed.pathname) : null;
  const headerLastEventId = request.headers['last-event-id'];
  const lastEventId = typeof headerLastEventId === 'string' ? headerLastEventId : parsed.searchParams.get('lastEventId') ?? undefined;
  if (eventMatch?.[1] !== undefined) { await streamEvents(request, response, options.events, decodePath(eventMatch[1]), lastEventId); return; }

  if (method === 'POST' && parsed.pathname === '/runs') {
    const body = await readJson(request, maxBodyBytes);
    const run = toReplyOptions(body);
    const runId = run.runId ?? randomUUID();
    void consume(options.agent.replyStream({ ...run, runId }));
    writeJson(response, 202, { runId, status: 'started', eventsUrl: `/runs/${encodeURIComponent(runId)}/events` });
    return;
  }

  const resumeMatch = method === 'POST' ? /^\/runs\/([^/]+)\/resume$/u.exec(parsed.pathname) : null;
  if (resumeMatch?.[1] !== undefined) {
    const runId = decodePath(resumeMatch[1]);
    void consume(options.agent.resumeStream(runId));
    writeJson(response, 202, { runId, status: 'resuming', eventsUrl: `/runs/${encodeURIComponent(runId)}/events` });
    return;
  }
  writeJson(response, 404, { error: 'NOT_FOUND', message: 'Route not found.' });
}

async function streamEvents(request: IncomingMessage, response: ServerResponse, events: EventStreamService, runId: string, lastEventId: string | undefined): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.on('close', abort);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try {
    const openOptions = { runId, signal: controller.signal, ...(lastEventId === undefined ? {} : { lastEventId }) };
    for await (const frame of events.open(openOptions)) {
      if (response.destroyed) break;
      response.write(encodeSseFrame(frame));
    }
  } finally {
    request.off('close', abort);
    if (!response.writableEnded) response.end();
  }
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

function writeJson(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
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
