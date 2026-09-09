import { ModelFailure, type ModelFailureCategory } from '../model-failure.js';

export interface OpenAICompatibleErrorClassifierOptions {
  transientForbiddenCodes?: readonly string[];
  quotaCodes?: readonly string[];
  signal?: AbortSignal;
}

const DEFAULT_QUOTA_CODES = new Set([
  'insufficient_quota',
  'quota_exceeded',
  'billing_hard_limit_reached',
  'billing_limit_reached',
  'insufficient_balance',
  'payment_required',
]);

const NETWORK_CODES = new Set(['econnreset', 'econnrefused', 'enotfound', 'eai_again', 'enetunreach', 'ehostunreach']);

export function classifyOpenAICompatibleError(
  error: unknown,
  options: OpenAICompatibleErrorClassifierOptions = {},
): ModelFailure {
  if (error instanceof ModelFailure) return error;

  const record = asRecord(error);
  const signalAborted = options.signal?.aborted === true;
  const errorName = readString(record, 'name')?.toLowerCase();
  const errorCode = readString(record, 'code')?.toLowerCase();
  const providerCodes = providerErrorCodes(record);
  const status = readStatus(record);
  const retryAfterMs = readRetryAfterMs(record);
  const details = {
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };

  if (signalAborted || isAbortName(errorName, errorCode) || isTimeoutName(errorName, errorCode)) {
    return failure('aborted', 'Model call was aborted.', false, details, 'aborted');
  }
  if (status === 402) return failure('auth', 'Model billing limit was reached.', false, details, 'terminal');
  if (status === 429 && containsAny(providerCodes, options.quotaCodes ?? [...DEFAULT_QUOTA_CODES])) {
    return failure('rate_limit', 'Model quota was exhausted.', false, details, 'terminal');
  }
  if (status === 401) return failure('auth', 'Model authentication failed.', false, details, 'fallback_only');
  if (status === 400) return failure('protocol', 'Model request was rejected.', false, details, 'fallback_only');
  if (status === 403) {
    const transientCodes = options.transientForbiddenCodes ?? [];
    return containsAny(providerCodes, transientCodes)
      ? failure('auth', 'Model access was temporarily forbidden.', true, details, 'retryable')
      : failure('auth', 'Model access was forbidden.', false, details, 'fallback_only');
  }
  if (status === 429 || status === 408) return failure(status === 429 ? 'rate_limit' : 'timeout', 'Model request should be retried.', true, details, 'retryable');
  if (status !== undefined && status >= 500 && status <= 599) return failure('server', 'Model service failed temporarily.', true, details, 'retryable');

  if (isNetworkError(errorName, errorCode, record, new Set())) return failure('network', 'Model network request failed.', true, details, 'retryable');
  return failure('protocol', 'Model request failed.', false, details, 'fallback_only');
}

function failure(
  category: ModelFailureCategory,
  message: string,
  retryable: boolean,
  details: Record<string, unknown>,
  disposition: 'retryable' | 'fallback_only' | 'terminal' | 'aborted',
): ModelFailure {
  return new ModelFailure(category, message, retryable, details, { disposition });
}

function providerErrorCodes(record: Record<string, unknown>): string[] {
  const nested = asRecord(record.error);
  return [
    readString(record, 'code'),
    readString(record, 'type'),
    readString(nested, 'code'),
    readString(nested, 'type'),
  ].filter((value): value is string => value !== undefined).map((value) => value.toLowerCase());
}

function readStatus(record: Record<string, unknown>): number | undefined {
  const nestedResponse = asRecord(record.response);
  const status = [record.status, nestedResponse.status]
    .find((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599);
  return status;
}

function readRetryAfterMs(record: Record<string, unknown>): number | undefined {
  const response = asRecord(record.response);
  const candidates = [readHeader(record.headers), readHeader(response.headers), readHeader(asRecord(record.error).headers)];
  for (const value of candidates) {
    if (value === undefined) continue;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

function readHeader(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof Headers !== 'undefined' && value instanceof Headers) return value.get('retry-after') ?? undefined;
  const record = asRecord(value);
  const get = typeof record.get === 'function' ? record.get as (name: string) => unknown : undefined;
  if (typeof get === 'function') {
    const result = Reflect.apply(get, value, ['retry-after']);
    if (typeof result === 'string') return result;
  }
  for (const key of ['retry-after', 'Retry-After']) {
    const result = record[key];
    if (typeof result === 'string' || typeof result === 'number') return String(result);
  }
  return undefined;
}

function isAbortName(name: string | undefined, code: string | undefined): boolean {
  return name === 'aborterror' || name === 'cancelederror' || code === 'abort_err' || code === 'aborted';
}

function isTimeoutName(name: string | undefined, code: string | undefined): boolean {
  return name === 'timeouterror' || code === 'etimedout';
}

function isNetworkError(name: string | undefined, code: string | undefined, record: Record<string, unknown>, seen: Set<object>): boolean {
  if (code !== undefined && NETWORK_CODES.has(code)) return true;
  if (name === 'typeerror' || name === 'apiconnectionerror' || name === 'networkerror') return true;
  if (record.cause === undefined || typeof record.cause !== 'object' || record.cause === null || seen.has(record.cause)) return false;
  seen.add(record.cause);
  const cause = asRecord(record.cause);
  return isNetworkError(readString(cause, 'name')?.toLowerCase(), readString(cause, 'code')?.toLowerCase(), cause, seen);
}

function containsAny(values: readonly string[], candidates: readonly string[]): boolean {
  const allowed = new Set(candidates.map((value) => value.toLowerCase()));
  return values.some((value) => allowed.has(value));
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}
