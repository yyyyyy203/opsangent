import type { AgentEventTypeV2 } from '../../contracts/event-v2/index.js';
import type { EventVisibilityV2 } from '../../contracts/event-v2/common.js';

/**
 * Lifecycle events that are safe for the public Web/SSE projection.
 *
 * Tool output deltas and governance/audit events remain private. The public
 * projector still removes tool response bodies and sensitive fields before
 * transport, so this policy only controls which lifecycle envelope is
 * eligible for that projection.
 */
export function visibilityForV2Event(type: AgentEventTypeV2): EventVisibilityV2 {
  if (type.startsWith('RUN_')
    || type.startsWith('STEP_')
    || type === 'REASONING_STARTED'
    || type === 'LOOP_DETECTED'
    || type === 'TOOL_CALL_CREATED'
    || type === 'TOOL_STARTED'
    || type === 'TOOL_RESULT'
    || type === 'TOOL_FAILED') {
    return 'public';
  }
  return 'audit';
}
