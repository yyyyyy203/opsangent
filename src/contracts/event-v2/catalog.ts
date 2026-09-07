import type { z } from 'zod';
import type { AgentEventEnvelopeBaseV2, UnsequencedAgentEventBaseV2 } from './common.js';
import type { ExecutionEventPayloadMap } from './execution.js';
import { executionEventPayloadSchemas } from './execution.js';
import type { EventV2PayloadMapSlice } from './lifecycle.js';
import { eventV2PayloadSchemas } from './lifecycle.js';
import type { SubsystemEventPayloadMap } from './subsystem.js';
import { subsystemEventPayloadSchemaMap } from './subsystem.js';

export interface AgentEventPayloadMap
  extends EventV2PayloadMapSlice, ExecutionEventPayloadMap, SubsystemEventPayloadMap {}

export type AgentEventTypeV2 = keyof AgentEventPayloadMap;

export type AgentEventEnvelopeV2<T extends AgentEventTypeV2 = AgentEventTypeV2> =
  AgentEventEnvelopeBaseV2<T, AgentEventPayloadMap[T]>;

export type UnsequencedAgentEventV2<T extends AgentEventTypeV2 = AgentEventTypeV2> =
  UnsequencedAgentEventBaseV2<T, AgentEventPayloadMap[T]>;

export const agentEventPayloadSchemas = {
  ...eventV2PayloadSchemas,
  ...executionEventPayloadSchemas,
  ...subsystemEventPayloadSchemaMap,
} as const satisfies Record<AgentEventTypeV2, z.ZodTypeAny>;

export const AGENT_EVENT_TYPES_V2 = Object.freeze(
  Object.keys(agentEventPayloadSchemas) as AgentEventTypeV2[],
);

export function parseAgentEventV2Payload<T extends AgentEventTypeV2>(
  type: T,
  payload: unknown,
): AgentEventPayloadMap[T] {
  const schema = agentEventPayloadSchemas[type] as unknown as z.ZodType<AgentEventPayloadMap[T]>;
  return schema.parse(payload);
}
