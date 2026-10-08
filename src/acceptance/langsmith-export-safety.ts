import { timestampV2Schema } from '../contracts/event-v2/common.js';
import { isSafeLangSmithRunPayload } from './langsmith-verifier.js';
import { containsSensitivePublicContent, isForbiddenPublicFieldName } from './privacy-audit.js';

const MAX_BODY_BYTES = 1_048_576;
const BATCH_OPERATIONS = new Set(['post', 'patch', 'pre']);
const RUN_FIELDS = new Set([
  'id', 'name', 'run_type', 'trace_id', 'parent_run_id', 'inputs', 'outputs', 'extra', 'error',
  'start_time', 'end_time', 'tags', 'session_name', 'dotted_order', 'reference_example_id',
  'child_runs', 'attachments', 'events', 'serialized',
]);
const REMOTE_SELECTED_FIELDS = [
  'id', 'trace_id', 'parent_run_id', 'name', 'run_type', 'end_time', 'status', 'error', 'inputs', 'outputs', 'extra',
];
const SAFE_TAGS = new Set(['agentops', 'event-v2', 'inspection-smoke']);

/** The existing JSON batch whitelist, independent of the acceptance runner. */
export function isSafeLangSmithExportBody(body: string, sensitiveValues: readonly string[] = []): boolean {
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return false;
  }
  if (!isPublicPayloadSafe(payload, sensitiveValues) || !isRecord(payload)
    || Object.keys(payload).some((key) => !BATCH_OPERATIONS.has(key))) return false;
  let runCount = 0;
  for (const [operation, candidate] of Object.entries(payload)) {
    if (!Array.isArray(candidate) || candidate.length > 512) return false;
    for (const run of candidate as unknown[]) {
      if (!isSafeExportRun(run, operation)) return false;
      runCount += 1;
    }
  }
  return runCount > 0;
}

function isPublicPayloadSafe(value: unknown, sensitiveValues: readonly string[]): boolean {
  let visited = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    visited += 1;
    if (visited > 100_000 || depth > 32) return false;
    if (candidate === null || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate === 'string') return !containsSensitivePublicContent(candidate, sensitiveValues);
    if (Array.isArray(candidate)) return candidate.length <= 20_000
      && (candidate as unknown[]).every((item) => visit(item, depth + 1));
    if (!isRecord(candidate)) return false;
    return Object.entries(candidate).every(([key, item]) => {
      if (isForbiddenPublicFieldName(key, sensitiveValues)) return false;
      if (key === 'rawSha256' && (typeof item !== 'string' || !/^[a-f\d]{64}$/iu.test(item))) return false;
      return visit(item, depth + 1);
    });
  };
  return visit(value, 0);
}

function isSafeExportRun(value: unknown, operation: string): boolean {
  if (!isRecord(value) || Object.keys(value).some((key) => !RUN_FIELDS.has(key))
    || !isSafeIdentifier(value['id'])) return false;
  if (operation === 'post' && (!isSafeIdentifier(value['name'])
    || typeof value['run_type'] !== 'string'
    || !['chain', 'tool', 'llm', 'retriever'].includes(value['run_type']))) return false;
  if (value['name'] !== undefined && !isSafeIdentifier(value['name'])) return false;
  if (value['run_type'] !== undefined && (typeof value['run_type'] !== 'string'
    || !['chain', 'tool', 'llm', 'retriever'].includes(value['run_type']))) return false;
  if (value['trace_id'] !== undefined && !isSafeIdentifier(value['trace_id'])) return false;
  if (value['parent_run_id'] !== undefined && value['parent_run_id'] !== null && !isSafeIdentifier(value['parent_run_id'])) return false;
  if (value['session_name'] !== undefined && !isSafeSessionName(value['session_name'])) return false;
  if (value['dotted_order'] !== undefined
    && (typeof value['dotted_order'] !== 'string' || !/^[A-Za-z0-9._:-]{1,1024}$/u.test(value['dotted_order']))) return false;
  if (value['reference_example_id'] !== undefined && value['reference_example_id'] !== null
    && !isSafeIdentifier(value['reference_example_id'])) return false;
  for (const key of ['child_runs', 'attachments', 'events'] as const) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].length !== 0)) return false;
  }
  if (value['serialized'] !== undefined && value['serialized'] !== null
    && (!isRecord(value['serialized']) || Object.keys(value['serialized']).length !== 0)) return false;
  const remoteShape = Object.fromEntries(REMOTE_SELECTED_FIELDS
    .filter((key) => Object.prototype.hasOwnProperty.call(value, key))
    .map((key) => [key, value[key]]));
  if (!isSafeLangSmithRunPayload(remoteShape)) return false;
  for (const key of ['start_time', 'end_time'] as const) {
    const timestamp = value[key];
    if (timestamp !== undefined && !(typeof timestamp === 'number' && Number.isFinite(timestamp))
      && !timestampV2Schema.safeParse(timestamp).success) return false;
  }
  return value['tags'] === undefined || (Array.isArray(value['tags']) && value['tags'].length <= 16
    && (value['tags'] as unknown[]).every((tag) => typeof tag === 'string' && SAFE_TAGS.has(tag)));
}

function isSafeSessionName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
    && ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
