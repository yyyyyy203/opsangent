import { z } from 'zod';

export const settlementInput = z.object({ service: z.literal('checkout') }).strict();
export const settlementInputSchema = {
  type: 'object' as const, properties: { service: { type: 'string', const: 'checkout' } },
  required: ['service'], additionalProperties: false,
};
export const settlementRemoteName = 'get_settlement_snapshot';
export const settlementWireResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), counts: z.object({ total: z.number().int().nonnegative().safe(), failed: z.number().int().nonnegative().safe() }),
    start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), raw: z.unknown() }),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['missing_series', 'ambiguous_series', 'invalid_data', 'stale_window']) }),
  z.object({ status: z.literal('source_error'), code: z.enum(['MCP_AUTH_ERROR', 'MCP_SERVER_ERROR', 'MCP_TIMEOUT', 'MCP_NETWORK_ERROR', 'MCP_PROTOCOL_ERROR', 'ABORTED']) }),
]);
