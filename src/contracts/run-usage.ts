import type { EventStore } from './event-store.js';
import type { AgentEventEnvelopeV2 } from './event-v2/index.js';

export type UsageCompleteness = 'complete' | 'partial' | 'unavailable';

/** Token totals derived only from durable model-call audit events. */
export interface RunUsageSummary {
  completeness: UsageCompleteness;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

const EVENT_PAGE_SIZE = 250;

export async function readRunUsageSummary(store: EventStore, runId: string): Promise<RunUsageSummary> {
  const modelEvents: AgentEventEnvelopeV2[] = [];
  let afterSequence = 0;
  for (;;) {
    const page = await store.readRun(runId, afterSequence, EVENT_PAGE_SIZE);
    for (const event of page) {
      if (event.type === 'MODEL_CALL_STARTED' || event.type === 'MODEL_CALL_COMPLETED'
        || event.type === 'MODEL_CALL_FAILED' || event.type === 'MODEL_RETRY_SCHEDULED'
        || event.type === 'MODEL_FALLBACK_ACTIVATED') modelEvents.push(event);
    }
    if (page.length < EVENT_PAGE_SIZE) break;
    afterSequence = page.at(-1)!.sequence;
  }
  return summarizeRunUsage(modelEvents);
}

export function summarizeRunUsage(events: readonly AgentEventEnvelopeV2[]): RunUsageSummary {
  type Terminal = Extract<AgentEventEnvelopeV2, { type: 'MODEL_CALL_COMPLETED' | 'MODEL_CALL_FAILED' }>;
  const terminals = new Map<string, Terminal>();
  const starts = new Map<string, AgentEventEnvelopeV2>();
  let hasIncompleteAttempt = false;
  for (const event of new Map(events.map((item) => [item.eventId, item])).values()) {
    const key = event.attemptId === undefined ? event.eventId : `${event.runId}:${event.attemptId}`;
    if (event.type === 'MODEL_CALL_STARTED') starts.set(key, event);
    if (event.type === 'MODEL_CALL_COMPLETED' || event.type === 'MODEL_CALL_FAILED') {
      const previous = terminals.get(key);
      if (previous === undefined) terminals.set(key, event);
      else if (previous.type !== event.type || JSON.stringify(previous.payload.usage) !== JSON.stringify(event.payload.usage)) hasIncompleteAttempt = true;
    }
    if (event.type === 'MODEL_CALL_FAILED' || event.type === 'MODEL_RETRY_SCHEDULED' || event.type === 'MODEL_FALLBACK_ACTIVATED') hasIncompleteAttempt = true;
  }
  if (terminals.size === 0) return { completeness: starts.size === 0 ? 'unavailable' : 'partial' };
  if (starts.size > terminals.size || [...starts].some(([key, event]) => event.attemptId !== undefined && !terminals.has(key))) hasIncompleteAttempt = true;

  const result: RunUsageSummary = { completeness: 'complete' };
  for (const field of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
    let total = 0;
    let known = 0;
    let overflow = false;
    for (const event of terminals.values()) {
      const count = event.payload.usage?.[field];
      if (count === undefined || !Number.isSafeInteger(count) || count < 0) continue;
      if (!Number.isSafeInteger(total + count)) overflow = true;
      else { total += count; known += 1; }
    }
    if (known > 0 && !overflow) result[field] = total;
    if (field !== 'cachedInputTokens' && (known !== terminals.size || overflow)) hasIncompleteAttempt = true;
  }
  result.completeness = hasIncompleteAttempt ? 'partial' : 'complete';
  return result;
}
