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
  const completed = events.filter((event) => event.type === 'MODEL_CALL_COMPLETED');
  if (completed.length === 0) {
    return { completeness: events.length === 0 ? 'unavailable' : 'partial' };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let allInputKnown = true;
  let allOutputKnown = true;
  let allCachedInputKnown = true;
  for (const event of completed) {
    if (event.type !== 'MODEL_CALL_COMPLETED' || event.payload.usage === undefined) {
      allInputKnown = false;
      allOutputKnown = false;
      allCachedInputKnown = false;
      continue;
    }
    const usage = event.payload.usage;
    if (usage.inputTokens === undefined || !Number.isSafeInteger(usage.inputTokens)
      || !Number.isSafeInteger(inputTokens + usage.inputTokens)) allInputKnown = false;
    else inputTokens += usage.inputTokens;
    if (usage.outputTokens === undefined || !Number.isSafeInteger(usage.outputTokens)
      || !Number.isSafeInteger(outputTokens + usage.outputTokens)) allOutputKnown = false;
    else outputTokens += usage.outputTokens;
    if (usage.cachedInputTokens === undefined || !Number.isSafeInteger(usage.cachedInputTokens)
      || !Number.isSafeInteger(cachedInputTokens + usage.cachedInputTokens)) allCachedInputKnown = false;
    else cachedInputTokens += usage.cachedInputTokens;
  }

  const started = events.filter((event) => event.type === 'MODEL_CALL_STARTED').length;
  const hasIncompleteAttempt = started > completed.length || events.some((event) => event.type === 'MODEL_CALL_FAILED'
    || event.type === 'MODEL_RETRY_SCHEDULED' || event.type === 'MODEL_FALLBACK_ACTIVATED');
  const completeness: UsageCompleteness = !hasIncompleteAttempt && allInputKnown && allOutputKnown
    ? 'complete'
    : 'partial';
  return {
    completeness,
    ...(allInputKnown ? { inputTokens } : {}),
    ...(allOutputKnown ? { outputTokens } : {}),
    ...(allCachedInputKnown ? { cachedInputTokens } : {}),
  };
}
