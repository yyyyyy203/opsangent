import { z } from 'zod';
import { isJsonValue } from '../message-v2/common.js';
import { agentEventEnvelopeV2Schema } from './common.js';
import {
  agentEventPayloadSchemas,
  type AgentEventEnvelopeV2,
  type AgentEventTypeV2,
} from './catalog.js';

export const agentEventV2Schema = agentEventEnvelopeV2Schema.superRefine((event, context) => {
  if (!Object.prototype.hasOwnProperty.call(agentEventPayloadSchemas, event.type)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'Unknown Event V2 type' });
    return;
  }
  const type = event.type as AgentEventTypeV2;
  const parsed = agentEventPayloadSchemas[type].safeParse(event.payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ['payload', ...issue.path] });
    }
  }
});

export function safeParseAgentEventV2(
  input: unknown,
): z.SafeParseReturnType<unknown, AgentEventEnvelopeV2> {
  if (!isJsonValue(input)) return unsafeEventResult();
  try {
    return agentEventV2Schema.safeParse(input) as z.SafeParseReturnType<unknown, AgentEventEnvelopeV2>;
  } catch {
    return unsafeEventResult();
  }
}

export function parseAgentEventV2(input: unknown): AgentEventEnvelopeV2 {
  const result = safeParseAgentEventV2(input);
  if (!result.success) throw result.error;
  return result.data;
}

export function isAgentEventV2(input: unknown): input is AgentEventEnvelopeV2 {
  return safeParseAgentEventV2(input).success;
}

function unsafeEventResult(): z.SafeParseReturnType<unknown, AgentEventEnvelopeV2> {
  return {
    success: false,
    error: new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'Expected a JSON-safe AgentEventV2 input',
    }]),
  };
}
