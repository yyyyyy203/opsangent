import type { Tool, ToolInputSchema, ValidationResult } from '../contracts/index.js';
import { isToolInputSchema } from '../contracts/index.js';
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
