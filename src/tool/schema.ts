import type { Tool, ToolCall, ToolInputSchema, ValidationResult } from '../contracts/index.js';
import { checkpointChecksum, isToolInputSchema } from '../contracts/index.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export function validateToolInput(tool: Tool, input: Record<string, unknown>): ValidationResult {
  if (isToolInputSchema(tool.inputSchema)) return tool.inputSchema.validate(input);
  const parsed = tool.inputSchema.strict().safeParse(input);
  if (parsed.success) return { valid: true, value: parsed.data };
  return {
    valid: false,
    error: {
      code: 'INVALID_INPUT',
      message: `Invalid input for ${tool.name}.`,
      retryable: false,
      details: { issues: parsed.error.issues },
    },
  };
}

/** Returns the exact call shape used by both governance and execution. */
export function normalizeToolCall(tool: Tool, call: ToolCall): ToolCall {
  const validation = validateToolInput(tool, call.input);
  if (!validation.valid || validation.value === undefined) return call;
  const semantics = tool.validateSemantics?.(validation.value);
  if (semantics !== undefined && !semantics.valid) return call;
  return { ...call, input: semantics?.value ?? validation.value };
}

/** Digest the canonical input shape used for snapshot and journal identity. */
export function toolInputDigest(tool: Tool, call: ToolCall): string {
  return checkpointChecksum(normalizeToolCall(tool, call).input);
}

export function toolInputJsonSchema(tool: Tool): Record<string, unknown> {
  if (isToolInputSchema(tool.inputSchema)) return tool.inputSchema.jsonSchema;
  return zodToJsonSchema(tool.inputSchema, { $refStrategy: 'none' });
}

export function jsonToolInputSchema(
  jsonSchema: Record<string, unknown>,
  validate: ToolInputSchema['validate'],
): ToolInputSchema {
  return { jsonSchema, validate };
}
