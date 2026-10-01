import type { Clock, Tool, ToolCallOptions, ToolResponse, ToolResponseChunk } from '../contracts/index.js';
import { settlementInput } from '../mcp/settlement-protocol.js';
import { SourceFailure, type ResilientExecutor } from '../mcp/resilience.js';
import { HttpMcpConnection } from '../infrastructure/mcp/http-connection.js';
import { bindSettlementEvidenceTool } from './settlement-evidence-tool.js';
import type { EvidenceRecorder } from '../application/evidence-recorder.js';

export interface LazySettlementToolOptions {
  mcpUrl: string;
  recorder: EvidenceRecorder;
  executor: ResilientExecutor;
  clock: Clock;
  onClose?: (callback: () => void | Promise<void>) => void;
}

export function createLazySettlementEvidenceTool(options: LazySettlementToolOptions): {
  tool: Tool;
  close(): Promise<void>;
} {
  const connection = new HttpMcpConnection({ url: options.mcpUrl });
  let bound: Tool | undefined;
  let binding: Promise<Tool> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const lifecycleController = new AbortController();

  const close = async (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    lifecycleController.abort();
    const pendingBinding = binding;
    closePromise = (async () => {
      await pendingBinding?.catch(() => undefined);
      await connection.close();
    })();
    await closePromise;
  };

  const ensureBound = (callOptions: ToolCallOptions): Promise<Tool> => {
    if (closed) return Promise.reject(new SourceFailure('ABORTED'));
    if (bound !== undefined) return Promise.resolve(bound);
    if (binding !== undefined) return binding;

    const signal = AbortSignal.any([callOptions.signal, lifecycleController.signal]);
    const deadline = callOptions.deadline ?? options.clock.now().getTime() + 30_000;
    const attemptBudget = callOptions.networkAttemptBudget;
    const attempt = (async (): Promise<Tool> => {
      try {
        await options.executor.execute((attemptSignal) => connection.connect(attemptSignal), {
          signal,
          deadline,
          ...(attemptBudget === undefined ? {} : { attemptBudget }),
        });
        if (closed) throw new SourceFailure('ABORTED');
        const candidate = await bindSettlementEvidenceTool({
          connection,
          recorder: options.recorder,
          executor: options.executor,
          signal,
          now: () => options.clock.now().getTime(),
          deadline,
          ...(attemptBudget === undefined ? {} : { networkAttemptBudget: attemptBudget }),
        });
        if (closed || candidate.name !== 'metrics.settlement' || candidate.kind !== 'evidence' || candidate.source !== 'mcp') {
          throw new SourceFailure('MCP_PROTOCOL_ERROR');
        }
        bound = candidate;
        return candidate;
      } catch (error) {
        if (!closed) await connection.close().catch(() => undefined);
        throw safeFailure(error);
      }
    })();
    binding = attempt;
    void attempt.then(
      () => { if (binding === attempt) binding = undefined; },
      () => { if (binding === attempt) binding = undefined; },
    );
    return attempt;
  };

  const tool: Tool = Object.freeze({
    name: 'metrics.settlement',
    description: '查询 checkout 结算指标，返回失败率、证据引用和缺失证据；不判断根因。',
    kind: 'evidence',
    source: 'mcp',
    inputSchema: settlementInput,
    isConcurrencySafe: () => true,
    call: (input: Record<string, unknown>, callOptions: ToolCallOptions) => callLazy(input, callOptions, ensureBound),
  });

  options.onClose?.(close);
  return { tool, close };
}

async function* callLazy(
  input: Record<string, unknown>,
  callOptions: ToolCallOptions,
  ensureBound: (options: ToolCallOptions) => Promise<Tool>,
): AsyncGenerator<ToolResponseChunk, ToolResponse> {
  if (!settlementInput.safeParse(input).success) throw new SourceFailure('TOOL_ARGUMENTS_SCHEMA_INVALID');
  const bound = await ensureBound(callOptions);
  if (bound.call === undefined) throw new SourceFailure('MCP_PROTOCOL_ERROR');
  const returned = bound.call(input, callOptions);
  if (isAsyncGenerator(returned)) return yield* returned;
  if (returned instanceof Promise) return await returned;
  if (isToolResponse(returned)) return returned;
  throw new SourceFailure('MCP_PROTOCOL_ERROR');
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<ToolResponseChunk, ToolResponse> {
  return typeof value === 'object'
    && value !== null
    && Symbol.asyncIterator in value
    && typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function';
}

function isToolResponse(value: unknown): value is ToolResponse {
  return typeof value === 'object' && value !== null && Array.isArray((value as { blocks?: unknown }).blocks);
}

function safeFailure(error: unknown): SourceFailure {
  return error instanceof SourceFailure ? error : new SourceFailure('MCP_PROTOCOL_ERROR');
}
