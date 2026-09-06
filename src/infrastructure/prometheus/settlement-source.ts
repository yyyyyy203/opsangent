import { z } from 'zod';

const envelope = z.object({
  status: z.literal('success'),
  warnings: z.array(z.string()).optional(),
  data: z.object({ resultType: z.literal('vector'), result: z.array(z.object({
    metric: z.record(z.string()), value: z.tuple([z.number().finite(), z.string()]),
  })).max(20) }),
});

export type SettlementSnapshot =
  | { status: 'available'; counts: { total: number; failed: number }; start: number; end: number; raw: unknown }
  | { status: 'unavailable'; reason: 'missing_series' | 'ambiguous_series' | 'invalid_data' | 'stale_window' };

export class PrometheusQueryError extends Error {
  constructor(public readonly code: 'PROMETHEUS_HTTP_ERROR' | 'PROMETHEUS_INVALID_RESPONSE' | 'PROMETHEUS_RESPONSE_TOO_LARGE', public readonly httpStatus?: number) {
    super(code);
  }
}

export interface PrometheusSettlementOptions {
  url: string;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
}

/** Lab-only profile: no model-provided URLs, selectors, thresholds or time windows. */
export class PrometheusSettlementSource {
  private readonly base: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(options: PrometheusSettlementOptions) {
    this.base = new URL(options.url);
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password
      || this.base.search || this.base.hash || this.base.pathname !== '/') throw new Error('INVALID_PROMETHEUS_URL');
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async query(signal: AbortSignal): Promise<SettlementSnapshot> {
    signal.throwIfAborted();
    const at = this.now() / 1000;
    const url = new URL('/api/v1/query', this.base);
    url.searchParams.set('query', '{__name__=~"settlement_window_requests|settlement_window_start_seconds|settlement_window_end_seconds",service="checkout",environment="simulation"}');
    url.searchParams.set('time', String(at));
    url.searchParams.set('timeout', '5s');
    const response = await this.fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]), redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PrometheusQueryError('PROMETHEUS_HTTP_ERROR', response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new PrometheusQueryError('PROMETHEUS_INVALID_RESPONSE');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65536) {
          await reader.cancel();
          throw new PrometheusQueryError('PROMETHEUS_RESPONSE_TOO_LARGE');
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    signal.throwIfAborted();
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new PrometheusQueryError('PROMETHEUS_INVALID_RESPONSE'); }
    return parseSnapshot(raw, at);
  }
}

function parseSnapshot(raw: unknown, at: number): SettlementSnapshot {
  const parsed = envelope.safeParse(raw);
  if (!parsed.success || parsed.data.warnings?.length) return { status: 'unavailable', reason: 'invalid_data' };
  const values = new Map<string, number>();
  let exporter: string | undefined;
  for (const { metric, value: [timestamp, text] } of parsed.data.data.result) {
    const name = metric.__name__;
    const key = name === 'settlement_window_requests' ? metric.outcome : name;
    const identity = JSON.stringify(Object.entries(metric).filter(([label]) => label !== '__name__' && label !== 'outcome').sort(([a], [b]) => a.localeCompare(b)));
    const number = Number(text);
    if (metric.service !== 'checkout' || metric.environment !== 'simulation'
      || !key || !['success', 'failure', 'settlement_window_start_seconds', 'settlement_window_end_seconds'].includes(key)
      || (name !== 'settlement_window_requests' && metric.outcome !== undefined)
      || !/^\d+(?:\.0+)?$/u.test(text) || !Number.isSafeInteger(number)
      || timestamp > at || at - timestamp > 30) return { status: 'unavailable', reason: 'invalid_data' };
    if (values.has(key) || (exporter !== undefined && exporter !== identity)) return { status: 'unavailable', reason: 'ambiguous_series' };
    exporter = identity;
    values.set(key, number);
  }
  if (values.size !== 4) return { status: 'unavailable', reason: 'missing_series' };
  const start = values.get('settlement_window_start_seconds')!;
  const end = values.get('settlement_window_end_seconds')!;
  const failed = values.get('failure')!;
  const total = values.get('success')! + failed;
  if (end - start !== 300 || end > at || !Number.isSafeInteger(total)) return { status: 'unavailable', reason: 'invalid_data' };
  if (at - end > 120) return { status: 'unavailable', reason: 'stale_window' };
  return { status: 'available', counts: { total, failed }, start, end, raw };
}
