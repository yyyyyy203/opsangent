export interface LogsQueryPolicy {
  service: 'checkout';
  windowSeconds: 300;
  maxWindowSkewSeconds: 120;
  maxFutureSkewSeconds: 30;
}

export const logsLabQueryPolicy: Readonly<LogsQueryPolicy> = Object.freeze({
  service: 'checkout',
  windowSeconds: 300,
  maxWindowSkewSeconds: 120,
  maxFutureSkewSeconds: 30,
});

export function validateLogsScope(
  input: { service: string; start: string; end: string },
  policy: LogsQueryPolicy,
  nowMs: number,
): void {
  if (input.service !== policy.service || !Number.isFinite(nowMs)
    || !Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds <= 0
    || !Number.isFinite(policy.maxWindowSkewSeconds) || policy.maxWindowSkewSeconds < 0
    || !Number.isFinite(policy.maxFutureSkewSeconds) || policy.maxFutureSkewSeconds < 0) {
    throw new RangeError('LOGS_SCOPE_DENIED');
  }

  const startMs = parseStrictDateTime(input.start);
  const endMs = parseStrictDateTime(input.end);
  if (startMs === undefined || endMs === undefined || startMs >= endMs
    || endMs - startMs !== policy.windowSeconds * 1_000
    || nowMs - endMs > policy.maxWindowSkewSeconds * 1_000
    || endMs - nowMs > policy.maxFutureSkewSeconds * 1_000) {
    throw new RangeError('LOGS_SCOPE_DENIED');
  }
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
