import type { Finding, GuardInput, Guardian } from '../contracts/index.js';
import { finding } from './guard-engine.js';

const sensitiveKeyPattern = /(?:token|password|secret|api[-_]?key|authorization|cookie|credential)/i;

/** Applies deterministic governance checks to MCP-originated capabilities. */
export class McpGuardian implements Guardian {
  public readonly id = 'mcp-policy';

  public matches(input: GuardInput): boolean {
    return input.tool.source === 'mcp' || input.tool.name.startsWith('mcp.');
  }

  public inspect(input: GuardInput): Promise<Finding[]> {
    if (!this.matches(input)) return Promise.resolve([]);
    const findings: Finding[] = [];
    if (input.tool.kind === 'action' && input.tool.requireUserConfirm !== true) {
      findings.push(finding('mcp.action-capability', 'HIGH', 'MCP 动作能力必须显式经过确认。', input.tool.name));
    }
    const keys = sensitiveKeys(input.toolCall.input);
    if (keys.length > 0) {
      findings.push(finding('mcp.sensitive-input', 'CRITICAL', 'MCP 参数包含敏感字段名。', input.tool.name, { keys }));
    }
    return Promise.resolve(findings);
  }
}

function sensitiveKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => sensitiveKeys(item, `${path}[${index}]`));
  if (value === null || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const keys: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    const nextPath = path.length === 0 ? key : `${path}.${key}`;
    if (sensitiveKeyPattern.test(key)) keys.push(nextPath);
    keys.push(...sensitiveKeys(child, nextPath));
  }
  return keys;
}
