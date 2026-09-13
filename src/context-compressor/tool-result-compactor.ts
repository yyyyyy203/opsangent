import { canonicalJson } from '../contracts/stable-json.js';
import type { ToolExecutionResult, ToolResponse, ToolResponseBlock } from '../contracts/index.js';
import type { ToolResultCompaction, ToolResultCompactor } from './types.js';

const DEFAULT_MAX_BYTES = 16 * 1024;

export class ToolResultCompactionError extends Error {
  public readonly retryable = false;

  public constructor(
    public readonly code: 'BUDGET_EXCEEDED',
    message: string,
    public readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolResultCompactionError';
  }
}

export interface ToolResultCompactorOptions {
  maxBytes?: number;
}

/**
 * Builds a bounded model view of a ToolResult. It never creates or persists
 * evidence; the evidence reference must already be present in the result.
 */
export class DefaultToolResultCompactor implements ToolResultCompactor {
  private readonly maxBytes: number;

  public constructor(options: ToolResultCompactorOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new RangeError('maxBytes must be a positive safe integer');
    }
  }

  public compact(result: ToolExecutionResult, options: ToolResultCompactorOptions = {}): ToolResultCompaction {
    const maxBytes = options.maxBytes ?? this.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be a positive safe integer');
    const response = result.response;
    if (response === undefined) {
      return { result, decision: { level: 'none', originalBytes: 0, modelBytes: 0 } };
    }

    const originalBytes = serializedBytes(response);
    if (originalBytes <= maxBytes) {
      return { result, decision: { level: 'none', originalBytes, modelBytes: originalBytes } };
    }

    const evidenceIds = collectEvidenceIds(response);
    if (evidenceIds.length === 0) {
      throw this.budgetExceeded(originalBytes, maxBytes, []);
    }

    const compactedResponse = compactResponse(response, originalBytes, evidenceIds);
    const modelBytes = serializedBytes(compactedResponse);
    if (modelBytes > maxBytes) {
      throw this.budgetExceeded(originalBytes, maxBytes, evidenceIds, 'tool_result_compacted_too_large');
    }

    return {
      result: { ...result, response: compactedResponse },
      decision: { level: 'L0', originalBytes, modelBytes },
    };
  }

  private budgetExceeded(
    originalBytes: number,
    maxBytes: number,
    evidenceIds: readonly string[],
    category = 'tool_result_too_large',
  ): ToolResultCompactionError {
    return new ToolResultCompactionError('BUDGET_EXCEEDED', 'Tool result exceeds the model context budget', {
      category,
      originalBytes,
      maxBytes,
      evidenceIds: [...evidenceIds],
    });
  }
}

function compactResponse(response: ToolResponse, originalBytes: number, evidenceIds: readonly string[]): ToolResponse {
  const evidenceBlocks = uniqueEvidenceBlocks(response.blocks);
  return {
    blocks: [
      {
        type: 'json',
        value: {
          l0Compacted: true,
          originalBytes,
          evidenceIds: [...evidenceIds],
        },
      },
      ...evidenceBlocks,
    ],
    evidenceIds: [...evidenceIds],
    ...(response.isError === undefined ? {} : { isError: response.isError }),
  };
}

function collectEvidenceIds(response: ToolResponse): string[] {
  const values = [
    ...(response.evidenceIds ?? []),
    ...response.blocks.flatMap((block) => block.type === 'evidence_ref' ? [block.evidenceId] : []),
  ];
  return [...new Set(values)].filter((value) => value.length > 0);
}

function uniqueEvidenceBlocks(blocks: readonly ToolResponseBlock[]): Extract<ToolResponseBlock, { type: 'evidence_ref' }>[] {
  const seen = new Set<string>();
  const result: Extract<ToolResponseBlock, { type: 'evidence_ref' }>[] = [];
  for (const block of blocks) {
    if (block.type !== 'evidence_ref' || seen.has(block.evidenceId)) continue;
    seen.add(block.evidenceId);
    result.push({ ...block });
  }
  return result;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), 'utf8');
}
