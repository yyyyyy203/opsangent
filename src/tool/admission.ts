import type { AdmissionGate, AgentError, RawToolCall, ToolCall } from '../contracts/index.js';
import type { Toolkit } from './toolkit.js';
import { parseJsonArguments } from './json-arguments.js';
import { toolInputJsonSchema, validateToolInput } from './schema.js';

export interface AdmissionGateRecord {
  gate: AdmissionGate;
  outcome: 'passed' | 'repaired' | 'degraded' | 'rejected';
  errorCode?: AgentError['code'];
}
export type AdmissionResult =
  | { accepted: true; call: ToolCall; repairs: string[]; gates: AdmissionGateRecord[] }
  | { accepted: false; error: AgentError; gates: AdmissionGateRecord[] };

export class ToolAdmission {
  public constructor(private readonly toolkit: Toolkit) {}

  public validate(candidate: ToolCall | RawToolCall): AdmissionResult {
    const tool = this.toolkit.get(candidate.name);
    if (!tool) return { accepted: false, error: { code: 'TOOL_NOT_FOUND', message: 'Tool is not in the current scope.', retryable: false }, gates: [{ gate: 'tool_existence', outcome: 'rejected', errorCode: 'TOOL_NOT_FOUND' }] };
    const gates: AdmissionGateRecord[] = [{ gate: 'tool_existence', outcome: 'passed' }];
    let serialized: string;
    try { serialized = 'arguments' in candidate ? candidate.arguments : JSON.stringify(candidate.input); }
    catch { return this.reject('TOOL_ARGUMENTS_PARSE_FAILED', 'json_parse', 'non_json_input', gates); }
    const parsed = parseJsonArguments(serialized);
    if (!parsed.ok) return {
      accepted: false,
      error: { code: 'TOOL_ARGUMENTS_PARSE_FAILED', message: 'Tool arguments rejected.', retryable: false,
        details: { gate: 'json_parse', reason: parsed.reason, retryableByModel: true, expectedSchema: toolInputJsonSchema(tool) } },
      gates: [...gates, { gate: 'json_parse', outcome: 'rejected', errorCode: 'TOOL_ARGUMENTS_PARSE_FAILED' }],
    };
    gates.push({ gate: 'json_parse', outcome: parsed.repairs.length > 0 ? 'repaired' : 'passed' });
    const schema = validateToolInput(tool, parsed.value);
    if (!schema.valid || !schema.value) {
      return { accepted: false, error: {
        code: 'TOOL_ARGUMENTS_SCHEMA_INVALID', message: 'Arguments do not match the tool schema.', retryable: false,
        details: { gate: 'schema', retryableByModel: true, expectedSchema: toolInputJsonSchema(tool), issues: schema.error?.details?.issues },
      }, gates: [...gates, { gate: 'schema_validation', outcome: 'rejected', errorCode: 'TOOL_ARGUMENTS_SCHEMA_INVALID' }] };
    }
    gates.push({ gate: 'schema_validation', outcome: 'passed' });
    const semantic = tool.validateSemantics?.(schema.value);
    if (semantic && !semantic.valid) return { accepted: false, error: semantic.error, gates: [...gates, { gate: 'semantic_validation', outcome: 'rejected', errorCode: semantic.error.code }] };
    gates.push({ gate: 'semantic_validation', outcome: 'passed' });
    return {
      accepted: true, call: { id: candidate.id, name: candidate.name, input: semantic?.value ?? schema.value }, repairs: parsed.repairs, gates,
    };
  }

  private reject(code: AgentError['code'], gate: AdmissionGate, reason: string, previous: AdmissionGateRecord[] = []): AdmissionResult {
    return { accepted: false, error: { code, message: 'Tool arguments rejected.', retryable: false, details: { gate, reason, retryableByModel: true } }, gates: [...previous, { gate, outcome: 'rejected', errorCode: code }] };
  }
}
