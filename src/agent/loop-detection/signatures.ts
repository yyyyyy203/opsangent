import { checkpointChecksum } from '../../contracts/index.js';
import type { ToolExecutionResult, ToolResponseBlock } from '../../contracts/index.js';
import { toolInputDigest } from '../../tool/schema.js';
import type { LoopObservation, LoopSignatures } from './types.js';

export function createLoopCallSignature(input: Pick<LoopObservation, 'stage' | 'tool' | 'call'>): string {
  return checkpointChecksum({
    kind: 'loop-call-v1',
    stage: input.stage,
    toolName: input.call.name,
    inputDigest: toolInputDigest(input.tool, input.call),
  });
}

/**
 * Creates stable call/result digests for loop detection. The result digest is
 * deliberately a digest of a small, redacted projection rather than raw tool
 * output, so dynamic request IDs and large evidence bodies cannot defeat the
 * detector or enter durable state.
 */
export function createLoopSignatures(input: LoopObservation): LoopSignatures {
  const callSignature = createLoopCallSignature(input);
  const resultDigest = checkpointChecksum(sanitizeResult(input.result));
  const signature = checkpointChecksum({
    kind: 'loop-result-v1',
    callSignature,
    status: input.result.status,
    resultDigest,
  });
  return { callSignature, signature, signatureDigest: signature };
}

function sanitizeResult(result: ToolExecutionResult): Record<string, unknown> {
  const response = result.response;
  return {
    status: result.status,
    ...(result.error === undefined ? {} : {
      error: {
        code: result.error.code,
        retryable: result.error.retryable,
        ...(result.error.details === undefined ? {} : { details: sanitizeValue(result.error.details) }),
      },
    }),
    ...(response === undefined ? {} : {
      response: {
        blocks: response.blocks.map(sanitizeBlock).filter((block): block is Record<string, unknown> => block !== undefined),
        ...(response.metadata === undefined ? {} : { metadata: sanitizeValue(response.metadata) }),
        ...(response.isError === undefined ? {} : { isError: response.isError }),
      },
    }),
  };
}

function sanitizeBlock(block: ToolResponseBlock): Record<string, unknown> | undefined {
  switch (block.type) {
    case 'json':
      return { type: 'json', value: sanitizeValue(block.value) };
    case 'evidence_ref':
      // Evidence references are run-local identities. The referenced evidence
      // remains auditable in EvidenceStore, but a new capture must not defeat
      // loop detection solely because it received a new evidence ID.
      return { type: 'evidence_ref' };
    case 'artifact':
      return { type: 'artifact', ...(block.mediaType === undefined ? {} : { mediaType: block.mediaType }) };
    case 'text':
      // Free-form text is usually raw logs or a changing error explanation.
      return { type: 'text' };
    default:
      return undefined;
  }
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limited]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return typeof value === 'number' && !Number.isFinite(value) ? '[non-finite]' : value;
  }
  if (typeof value === 'string') return value.slice(0, 256);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value !== 'object') return `[${typeof value}]`;

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (isVolatileKey(key)) continue;
    const item = sanitizeValue(record[key], depth + 1);
    if (item !== undefined) output[key] = item;
  }
  return output;
}

function isVolatileKey(key: string): boolean {
  const normalized = key.replace(/[-_]/g, '').toLowerCase();
  return normalized === 'id'
    || normalized.endsWith('id')
    || normalized.endsWith('ids')
    || normalized.includes('timestamp')
    || normalized.includes('capturedat')
    || normalized.includes('createdat')
    || normalized.includes('updatedat')
    || normalized.includes('finishedat')
    || normalized.includes('startedat')
    || normalized.includes('cursor')
    || normalized.includes('pagination')
    || normalized === 'request'
    || normalized === 'requests'
    || normalized === 'trace'
    || normalized === 'traces'
    || normalized === 'raw'
    || normalized === 'log'
    || normalized === 'logs'
    || normalized === 'sample'
    || normalized === 'samples'
    || normalized === 'body'
    || normalized === 'payload'
    || normalized === 'message'
    || normalized === 'text'
    || normalized === 'uri';
}
