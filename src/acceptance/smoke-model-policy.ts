import type { AgentMessage, ChatModel, ModelCallOptions, ModelResponse, ModelStreamEvent, Tool } from '../contracts/index.js';
import type { SmokeModelDecision } from './diagnostics.js';

type SmokePhase = SmokeModelDecision['phase'];
const POLICIES: Readonly<Record<SmokePhase, string>> = {
  query: '[AGENTOPS_SMOKE_PHASE=query]\n本轮是限额巡检烟测。优先直接调用工具，不输出长篇分析。父 Agent 各调用一次 metrics_subagent、logs_subagent，问题简短且时间窗口一致；来源 Agent 只查询必要证据，满足后立即调用 source_report，不重复查已取得的数据。',
  report: '[AGENTOPS_SMOKE_PHASE=report]\n本轮是限额巡检烟测。已有查询证据，优先立即调用 source_report：summary 不超过100字，findings 最多3条、每条不超过80字，仅引用真实已取得的 evidenceId。不得输出原文、地址、路径或凭据；缺失项写入 missingEvidence，不捏造根因。如仍必须查询，仅补关键缺口。source_report 成功后用一句话结束。',
  summary: '[AGENTOPS_SMOKE_PHASE=summary]\n本轮是限额巡检烟测。汇总已有来源结果并结束，最终摘要不超过250字，包含异常、关键数值、证据引用、missingEvidence 和建议。来源 partial/unavailable 必须明确，不得重复调用来源或声称生产已验证。不得复述原始数据、地址或凭据。',
};

/** A smoke-only decorator: no production schema, Tool registry or Harness changes. */
export function createSmokeModelPolicy(
  delegate: ChatModel,
  policyOptions: { onDecision?: (value: SmokeModelDecision) => void } = {},
): ChatModel {
  return {
    async *stream(messages: AgentMessage[], tools: Tool[], options: ModelCallOptions): AsyncGenerator<ModelStreamEvent, ModelResponse> {
      const phase = selectPhase(messages, tools);
      const policy: AgentMessage = {
        id: 'inspection-smoke-output-policy', role: 'system',
        createdAt: messages.at(-1)?.createdAt ?? '2026-10-07T00:00:00.000Z',
        blocks: [{ type: 'text', text: POLICIES[phase] }],
      };
      policyOptions.onDecision?.({
        runId: options.runId, stepId: options.stepId,
        ...(options.streamId === undefined ? {} : { streamId: options.streamId }),
        phase, maxOutputTokens: phase === 'query' ? 512 : 1024,
      });
      return yield* delegate.stream([...messages, policy], tools, options);
    },
  };
}

/** Only the exact trusted tail policy can opt into the larger per-call cap. */
export function selectSmokeOutputTokens(body: Readonly<Record<string, unknown>>): 512 | 1024 {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return 512;
  const tail: unknown = messages.at(-1);
  if (typeof tail !== 'object' || tail === null || Array.isArray(tail)) return 512;
  const fields = tail as Record<string, unknown>;
  return fields['role'] === 'system' && (fields['content'] === POLICIES.report || fields['content'] === POLICIES.summary)
    ? 1024 : 512;
}

function selectPhase(messages: readonly AgentMessage[], tools: readonly Tool[]): SmokePhase {
  const results = successfulToolNames(messages);
  if (tools.some((tool) => tool.name === 'source_report')) {
    if (results.has('source_report')) return 'summary';
    if (hasEvidenceForTool(messages, 'metrics.settlement')) return 'report';
    const captured = evidenceIdsForTool(messages, 'logs.capture');
    const searched = evidenceIdsForTool(messages, 'logs.search_evidence');
    const sliced = evidenceIdsForTool(messages, 'logs.read_evidence_slice');
    if (intersects(captured, searched) || intersects(captured, sliced)) return 'report';
  } else if (results.has('metrics_subagent') && results.has('logs_subagent')) return 'summary';
  return 'query';
}

function successfulToolNames(messages: readonly AgentMessage[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) for (const block of message.blocks) {
    if (block.type === 'tool_result' && block.result.status === 'success' && block.result.response?.isError !== true) {
      names.add(block.result.toolName);
    }
  }
  return names;
}

function hasEvidenceForTool(messages: readonly AgentMessage[], toolName: string): boolean {
  return evidenceIdsForTool(messages, toolName).size > 0;
}

function evidenceIdsForTool(messages: readonly AgentMessage[], toolName: string): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) for (const block of message.blocks) {
    if (block.type !== 'tool_result' || block.result.toolName !== toolName
      || block.result.status !== 'success' || block.result.response?.isError === true) continue;
    for (const evidenceId of block.result.response?.evidenceIds ?? []) {
      if (isEvidenceId(evidenceId)) ids.add(evidenceId);
    }
    for (const responseBlock of block.result.response?.blocks ?? []) {
      if (responseBlock.type === 'evidence_ref' && isEvidenceId(responseBlock.evidenceId)) ids.add(responseBlock.evidenceId);
    }
  }
  return ids;
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

function isEvidenceId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}
