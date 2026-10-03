import { z } from 'zod';
import {
  canonicalJson,
  type AgentErrorCode,
  type JsonValue,
  type LogEvidenceQuery,
  type NormalizedLogRecord,
} from '../contracts/index.js';

const MAX_TEXT_LENGTH = 256;
const MAX_CONTAINS_LENGTH = 1_024;
const MAX_CURSOR_LENGTH = 4 * 1_024;
const MAX_PAGE_RECORDS = 32;
const MAX_RECORD_BYTES = 8 * 1_024;

const isoDateTime = z.string().max(MAX_TEXT_LENGTH).refine(isStrictDateTime, {
  message: 'Expected a valid ISO date-time with an explicit timezone',
});
const boundedText = z.string().max(MAX_TEXT_LENGTH);
const nonEmptyBoundedText = z.string().min(1).max(MAX_TEXT_LENGTH);
const cursorSchema = z.string().min(1).max(MAX_CURSOR_LENGTH);

const elkQueryFields = {
  service: z.string().min(1).max(MAX_TEXT_LENGTH),
  start: isoDateTime,
  end: isoDateTime,
  level: boundedText.optional(),
  traceId: boundedText.optional(),
  contains: z.string().max(MAX_CONTAINS_LENGTH).optional(),
} satisfies { [Key in keyof LogEvidenceQuery]: z.ZodTypeAny };

const elkEvidenceQuerySchema = z.object(elkQueryFields).strict();

export const logsSearchPageInput = elkEvidenceQuerySchema.extend({
  cursor: cursorSchema.optional(),
  sourceSnapshotId: nonEmptyBoundedText.optional(),
  requestId: nonEmptyBoundedText.optional(),
}).strict().superRefine((input, context) => {
  const hasCursor = input.cursor !== undefined;
  const hasSnapshot = input.sourceSnapshotId !== undefined;
  if (hasCursor !== hasSnapshot) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasCursor ? 'sourceSnapshotId' : 'cursor'],
      message: 'cursor and sourceSnapshotId must be supplied together',
    });
  }
  if (!hasCursor && input.requestId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['requestId'],
      message: 'requestId is required for a new snapshot query',
    });
  }
});

export type LogsSearchPageInput = z.infer<typeof logsSearchPageInput>;

export const logsCloseSnapshotInput = z.object({
  sourceSnapshotId: nonEmptyBoundedText,
}).strict();

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

const normalizedLogRecordSchema = z.object({
  timestamp: isoDateTime,
  service: z.string().optional(),
  level: z.string().optional(),
  message: z.string().optional(),
  exception: z.string().optional(),
  traceId: z.string().optional(),
  fields: z.record(z.string(), jsonValueSchema).optional(),
}).strict().superRefine((record, context) => {
  let encodedBytes: number;
  try {
    encodedBytes = new TextEncoder().encode(canonicalJson(record)).byteLength;
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Log record must be JSON serializable' });
    return;
  }
  if (encodedBytes > MAX_RECORD_BYTES) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Log record exceeds the byte limit' });
  }
});

const logErrorCodes = [
  'INVALID_INPUT',
  'POLICY_DENIED',
  'UNAVAILABLE',
  'MCP_AUTH_ERROR',
  'MCP_NETWORK_ERROR',
  'MCP_TIMEOUT',
  'MCP_RATE_LIMITED',
  'MCP_SERVER_ERROR',
  'MCP_PROTOCOL_ERROR',
  'ABORTED',
  'BUDGET_EXCEEDED',
] as const satisfies readonly AgentErrorCode[];

const logSourceErrorReasons = [
  'snapshot_expired',
  'cursor_invalid',
  'scope_denied',
  'response_too_large',
  'source_unavailable',
] as const;

export const logsPageWireResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('available'),
    records: z.array(normalizedLogRecordSchema).max(MAX_PAGE_RECORDS),
    sourceSnapshotId: nonEmptyBoundedText,
    nextCursor: cursorSchema.optional(),
  }).strict(),
  z.object({
    status: z.literal('source_error'),
    code: z.enum(logErrorCodes),
    reason: z.enum(logSourceErrorReasons).optional(),
  }).strict(),
]);

type LogsPageErrorCode = typeof logErrorCodes[number];
type LogsPageErrorReason = typeof logSourceErrorReasons[number];

export type LogsPageWireResult =
  | {
    status: 'available';
    records: NormalizedLogRecord[];
    sourceSnapshotId: string;
    nextCursor?: string;
  }
  | {
    status: 'source_error';
    code: LogsPageErrorCode;
    reason?: LogsPageErrorReason;
  };

export interface LogsPageBackend {
  searchPage(input: LogsSearchPageInput, signal: AbortSignal): Promise<LogsPageWireResult>;
  closeSnapshot(input: { sourceSnapshotId: string }, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

function isStrictDateTime(value: string): boolean {
  return parseStrictDateTime(value) !== undefined;
}

function parseStrictDateTime(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? '';
  const offsetHour = Number(match[10] ?? 0);
  const offsetMinute = Number(match[11] ?? 0);
  const daysInMonth = month === 2
    ? (isLeapYear(year) ? 29 : 28)
    : ([4, 6, 9, 11].includes(month) ? 30 : 31);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) return undefined;

  const localDate = new Date(0);
  localDate.setUTCFullYear(year, month - 1, day);
  localDate.setUTCHours(hour, minute, second, Number(fraction.padEnd(3, '0')));
  const offsetSign = match[9] === '+' ? 1 : match[9] === '-' ? -1 : 0;
  const offsetMs = offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  return localDate.getTime() - offsetMs;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
