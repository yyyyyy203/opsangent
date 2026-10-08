import type { AgentEventEnvelopeV2 } from '../contracts/index.js';
import { agentErrorCodeV2Schema } from '../contracts/event-v2/common.js';
import { isModelFailureCategory } from '../model/model-failure.js';
import type { AcceptanceReport } from './types.js';

/** Shares the same bounded, allowlisted diagnostics for successful and failed parent runs. */
export function collectAcceptanceFailures(
  events: readonly AgentEventEnvelopeV2[],
  runIds: ReadonlySet<string>,
): NonNullable<AcceptanceReport['failures']> {
  const failures: NonNullable<AcceptanceReport['failures']> = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (!runIds.has(event.runId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(event.runId)) continue;
    if (event.type !== 'MODEL_CALL_FAILED' && event.type !== 'RUN_FAILED') continue;
    const error = event.payload.error;
    if (!agentErrorCodeV2Schema.safeParse(error.code).success) continue;
    const category = error.details?.['category'];
    const failure = {
      runId: event.runId,
      code: error.code,
      ...(isModelFailureCategory(category) ? { category } : {}),
    };
    const key = JSON.stringify(failure);
    if (seen.has(key)) continue;
    failures.push(failure);
    seen.add(key);
    if (failures.length === 100) break;
  }
  return failures;
}
