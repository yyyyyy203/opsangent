import type {
  SourceEvidenceObservation,
  SourceSubagentType,
  ToolResponse,
} from '../contracts/index.js';

export const SOURCE_EVIDENCE_METADATA_KEY = 'sourceEvidence';

const MAX_IDENTIFIER_CHARS = 256;
const MAX_MISSING_ITEMS = 20;
const MAX_MISSING_EVIDENCE_CHARS = 4_096;
const OBSERVATION_KEYS = new Set([
  'schemaVersion',
  'source',
  'evidenceId',
  'state',
  'coverage',
  'timeRange',
  'missingEvidence',
]);
const TIME_RANGE_KEYS = new Set(['start', 'end']);
const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function attachSourceEvidenceObservation(
  response: ToolResponse,
  observation: SourceEvidenceObservation,
): ToolResponse {
  const attached: ToolResponse = {
    ...response,
    metadata: {
      ...(response.metadata ?? {}),
      [SOURCE_EVIDENCE_METADATA_KEY]: observation,
    },
  };
  const validated = readSourceEvidenceObservation(attached);
  if (validated === undefined) throw new SourceEvidenceObservationError('source evidence is required');

  return {
    ...response,
    metadata: {
      ...(response.metadata ?? {}),
      [SOURCE_EVIDENCE_METADATA_KEY]: cloneObservation(validated),
    },
  };
}

export function readSourceEvidenceObservation(
  response: ToolResponse,
): SourceEvidenceObservation | undefined {
  const metadata = response.metadata;
  if (!isRecord(metadata) || !hasOwn(metadata, SOURCE_EVIDENCE_METADATA_KEY)) return undefined;
  const value = metadata[SOURCE_EVIDENCE_METADATA_KEY];
  if (!isRecord(value) || !hasOnlyKeys(value, OBSERVATION_KEYS)) {
    throw new SourceEvidenceObservationError('invalid source evidence observation');
  }
  if (value.schemaVersion !== 1 || !isSource(value.source) || !isIdentifier(value.evidenceId)
    || (value.state !== 'committed' && value.state !== 'partial')
    || typeof value.coverage !== 'number' || !Number.isFinite(value.coverage)
    || value.coverage < 0 || value.coverage > 1 || !isBoundedMissingEvidence(value.missingEvidence)) {
    throw new SourceEvidenceObservationError('invalid source evidence observation');
  }
  const timeRange = readTimeRange(value.timeRange);
  if (!includesEvidenceId(response.evidenceIds, value.evidenceId)
    || !hasEvidenceReference(response.blocks, value.evidenceId)) {
    throw new SourceEvidenceObservationError('source evidence must be retrievable from the response');
  }

  return {
    schemaVersion: 1,
    source: value.source,
    evidenceId: value.evidenceId,
    state: value.state,
    coverage: value.coverage,
    ...(timeRange === undefined ? {} : { timeRange }),
    missingEvidence: [...value.missingEvidence],
  };
}

export class SourceEvidenceObservationError extends Error {
  public readonly code = 'MCP_PROTOCOL_ERROR';
  public readonly retryable = false;

  public constructor(message: string) {
    super(message);
    this.name = 'SourceEvidenceObservationError';
  }
}

function readTimeRange(value: unknown): { start: string; end: string } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasOnlyKeys(value, TIME_RANGE_KEYS)
    || !isIsoTimestamp(value.start) || !isIsoTimestamp(value.end)
    || Date.parse(value.start) >= Date.parse(value.end)) {
    throw new SourceEvidenceObservationError('invalid source evidence time range');
  }
  return { start: value.start, end: value.end };
}

function cloneObservation(observation: SourceEvidenceObservation): SourceEvidenceObservation {
  return {
    ...observation,
    ...(observation.timeRange === undefined ? {} : { timeRange: { ...observation.timeRange } }),
    missingEvidence: [...observation.missingEvidence],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isSource(value: unknown): value is SourceSubagentType {
  return value === 'metrics' || value === 'logs' || value === 'traces';
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_CHARS;
}

function isBoundedMissingEvidence(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_MISSING_ITEMS
    && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= MAX_MISSING_EVIDENCE_CHARS);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (match === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  return calendar.getUTCFullYear() === year
    && calendar.getUTCMonth() === month - 1
    && calendar.getUTCDate() === day;
}

function includesEvidenceId(evidenceIds: unknown, evidenceId: string): boolean {
  return Array.isArray(evidenceIds) && evidenceIds.includes(evidenceId);
}

function hasEvidenceReference(blocks: ToolResponse['blocks'], evidenceId: string): boolean {
  return blocks.some((block) => block.type === 'evidence_ref' && block.evidenceId === evidenceId);
}
