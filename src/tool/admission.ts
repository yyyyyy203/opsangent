import type { AgentError, RawToolCall, ToolCall } from '../contracts/index.js';
import type { Toolkit } from './toolkit.js';
import { parseJsonArguments } from './json-arguments.js';
import { toolInputJsonSchema, validateToolInput } from './schema.js';

export type AdmissionResult =
  | { accepted: true; call: ToolCall; repairs: string[] }
  | { accepted: false; error: AgentError };

export class ToolAdmission {
  public constructor(private readonly toolkit: Toolkit) {}

  public validate(candidate: ToolCall | RawToolCall): AdmissionResult {
    const tool = this.toolkit.get(candidate.name);
    if (!tool) return { accepted: false, error: { code: 'TOOL_NOT_FOUND', message: 'Tool is not in the current scope.', retryable: false } };
    let serialized: string;
    try { serialized = 'arguments' in candidate ? candidate.arguments : JSON.stringify(candidate.input); }
    catch { return this.reject('TOOL_ARGUMENTS_PARSE_FAILED', 'json_parse', 'non_json_input'); }
    const parsed = parseJsonArguments(serialized);
    if (!parsed.ok) return this.reject('TOOL_ARGUMENTS_PARSE_FAILED', 'json_parse', parsed.reason);
    const schema = validateToolInput(tool, parsed.value);
    if (!schema.valid || !schema.value) {
      return { accepted: false, error: {
        code: 'TOOL_ARGUMENTS_SCHEMA_INVALID', message: 'Arguments do not match the tool schema.', retryable: false,
        details: { gate: 'schema', retryableByModel: true, expectedSchema: toolInputJsonSchema(tool), issues: schema.error?.details?.issues },
      } };
    }
    const semantic = tool.validateSemantics?.(schema.value);
    if (semantic && !semantic.valid) return { accepted: false, error: semantic.error };
    return {
      accepted: true, call: { id: candidate.id, name: candidate.name, input: semantic?.value ?? schema.value }, repairs: parsed.repairs,
    };
  }

  private reject(code: AgentError['code'], gate: string, reason: string): AdmissionResult {
    return { accepted: false, error: { code, message: 'Tool arguments rejected.', retryable: false, details: { gate, reason, retryableByModel: true } } };
  }
}
