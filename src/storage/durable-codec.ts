import { z } from 'zod';
import { canonicalJson, checkpointChecksum } from '../contracts/stable-json.js';
import type { AgentContext, PendingToolBatch } from '../contracts/context.js';
import type { EvidenceRecord, ToolExecutionRecord } from '../contracts/storage.js';

const timestamp = z.string().datetime({ offset: true });
const toolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.unknown()),
}).strict();
const toolResult = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  status: z.enum(['success', 'failed', 'timeout', 'aborted', 'interrupted', 'awaiting_external', 'skipped']),
  response: z.object({
    blocks: z.array(z.unknown()),
    evidenceIds: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.unknown()).optional(),
    isError: z.boolean().optional(),
  }).strict().optional(),
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    details: z.record(z.unknown()).optional(),
  }).strict().optional(),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
}).strict();

const rawToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
}).strict();
const contextSummary = z.object({
  confirmedFacts: z.array(z.string()),
  hypotheses: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  pendingActionIds: z.array(z.string()),
  executedActionIds: z.array(z.string()),
  unresolvedRisks: z.array(z.string()),
}).strict();
const messageBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z.object({ type: z.literal('tool_call'), call: toolCall }).strict(),
  z.object({ type: z.literal('raw_tool_call'), call: rawToolCall }).strict(),
  z.object({ type: z.literal('tool_result'), result: toolResult }).strict(),
  z.object({ type: z.literal('context_summary'), summary: contextSummary }).strict(),
]);
const agentMessage = z.object({
  id: z.string().min(1),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  blocks: z.array(messageBlock),
  createdAt: timestamp,
}).strict();
const agentError = z.object({
  code: z.string().min(1),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.unknown()).optional(),
}).strict();
const interrupt = z.object({
  hookId: z.string().min(1),
  interruptType: z.string().min(1),
  toolCallId: z.string().min(1),
  payload: z.record(z.unknown()),
  createdAt: timestamp,
  expiresAt: timestamp.optional(),
}).strict();

const pendingToolBatch = z.object({
  batchId: z.string().min(1),
  stepId: z.string().min(1),
  calls: z.array(toolCall).min(1),
  completedResults: z.array(toolResult),
  state: z.enum(['admitted', 'executing', 'awaiting_confirmation', 'awaiting_external']),
  createdAt: timestamp,
}).strict();

const agentContext = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  replyId: z.string().min(1).optional(),
  streamId: z.string().min(1).optional(),
  status: z.enum(['running', 'awaiting_confirmation', 'paused', 'completed', 'failed', 'cancelled']),
  stage: z.enum(['triage', 'evidence_collection', 'hypothesis', 'risk_gate', 'action', 'verification', 'postmortem']),
  profileId: z.string().min(1),
  messages: z.array(agentMessage),
  pendingToolCalls: z.array(toolCall),
  pendingToolBatch: pendingToolBatch.optional(),
  pendingInterrupt: interrupt.optional(),
  confirmedToolCallIds: z.array(z.string().min(1)),
  rejectedToolCallIds: z.array(z.string().min(1)),
  executedActions: z.array(toolResult),
  evidenceIds: z.array(z.string().min(1)),
  missingEvidence: z.array(z.string()),
  budget: z.object({
    startedAt: timestamp,
    maxIterations: z.number().int().positive(),
    iteration: z.number().int().nonnegative(),
    maxToolCalls: z.number().int().positive(),
    toolCallsUsed: z.number().int().nonnegative(),
    maxDurationMs: z.number().finite().positive(),
  }).strict(),
  contextVersion: z.number().int().positive(),
  toolCorrections: z.record(z.object({ firstCallId: z.string().min(1), failures: z.number().int().nonnegative() }).strict()).optional(),
  admittedToolCallIds: z.array(z.string().min(1)).optional(),
  networkAttemptBudget: z.object({ remaining: z.number().int().nonnegative() }).strict().optional(),
  failure: agentError.optional(),
}).strict();

const toolExecutionRecord = z.object({
  toolCallId: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  toolName: z.string().min(1),
  toolKind: z.enum(['evidence', 'action', 'utility']),
  inputDigest: z.string().min(1),
  state: z.enum(['prepared', 'succeeded', 'failed', 'uncertain']),
  result: toolResult.optional(),
  reasonCode: z.string().min(1).optional(),
  preparedAt: timestamp,
  finishedAt: timestamp.optional(),
}).strict();

const evidenceRecord = z.object({
  evidenceId: z.string().min(1),
  runId: z.string().min(1),
  source: z.enum(['metric', 'log', 'trace', 'change']),
  summary: z.record(z.unknown()),
  raw: z.unknown(),
  businessTraceIds: z.array(z.string().min(1)),
  capturedAt: timestamp,
  toolCallId: z.string().min(1).optional(),
  captureKey: z.string().min(1).optional(),
  schemaVersion: z.number().int().positive().optional(),
  rawSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

/** Produces stable JSON for checksums without accepting lossy JSON values. */
export { canonicalJson, checkpointChecksum };

export function parsePendingToolBatch(value: unknown): PendingToolBatch {
  const parsed = pendingToolBatch.parse(value);
  const callIds = new Set(parsed.calls.map((call) => call.id));
  if (callIds.size !== parsed.calls.length) throw new Error('pending batch contains duplicate tool call IDs');
  const completedIds = new Set<string>();
  for (const result of parsed.completedResults) {
    if (!callIds.has(result.toolCallId)) throw new Error('pending batch completed result does not belong to its calls');
    if (completedIds.has(result.toolCallId)) throw new Error('pending batch contains duplicate completed results');
    completedIds.add(result.toolCallId);
  }
  return structuredClone(parsed) as PendingToolBatch;
}

export function parseAgentContext(value: unknown): AgentContext {
  return structuredClone(agentContext.parse(value)) as AgentContext;
}

export function parseToolExecutionRecord(value: unknown): ToolExecutionRecord {
  return structuredClone(toolExecutionRecord.parse(value)) as ToolExecutionRecord;
}

export function parseEvidenceRecord(value: unknown): EvidenceRecord {
  return structuredClone(evidenceRecord.parse(value)) as EvidenceRecord;
}
