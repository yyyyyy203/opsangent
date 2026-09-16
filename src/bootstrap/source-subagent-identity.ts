import { createHash } from 'node:crypto';
import type { SourceSubagentType } from '../contracts/index.js';

export function stableSourceChildRunId(
  source: SourceSubagentType,
  parentRunId: string,
  parentToolCallId: string,
): string {
  const digest = createHash('sha256')
    .update(`${source}\u0000${parentRunId}\u0000${parentToolCallId}`)
    .digest('hex')
    .slice(0, 32);
  return `source-child-${source}-${digest}`;
}
