import { describe, expect, it } from 'vitest';
import { PrometheusSettlementSource } from '../src/infrastructure/prometheus/settlement-source.js';

function payload() {
  const metric = (name: string, value: string, outcome?: string) => ({ metric: { __name__: name, service: 'checkout', environment: 'simulation', ...(outcome ? { outcome } : {}) }, value: [1000, value] });
  return { status: 'success', data: { resultType: 'vector', result: [
    metric('settlement_window_requests', '85', 'success'), metric('settlement_window_requests', '15', 'failure'),
    metric('settlement_window_start_seconds', '700'), metric('settlement_window_end_seconds', '1000'),
  ] } };
}
const signal = new AbortController().signal;
function source(body: unknown) {
  return new PrometheusSettlementSource({ url: 'http://localhost:9090', now: () => 1_010_000, fetch: () => Promise.resolve(Response.json(body)) });
}
describe('Prometheus settlement snapshot boundary', () => {
  it('reads counts and window without letting the caller supply PromQL', async () => {
    let requested: URL | undefined;
    const provider = new PrometheusSettlementSource({ url: 'http://localhost:9090', now: () => 1_010_000, fetch: (url) => {
      requested = new URL(url instanceof Request ? url.url : url); return Promise.resolve(Response.json(payload()));
    } });
    expect(await provider.query(signal)).toMatchObject({ status: 'available', counts: { total: 100, failed: 15 }, start: 700, end: 1000 });
    expect(requested?.pathname).toBe('/api/v1/query');
    expect(requested?.searchParams.get('time')).toBe('1010');
    expect(requested?.searchParams.get('query')).toContain('service="checkout"');
  });
  it('returns missing evidence for an empty result', async () => {
    const body = payload(); body.data.result = [];
    expect(await source(body).query(signal)).toEqual({ status: 'unavailable', reason: 'missing_series' });
  });
  it('rejects duplicate series instead of summing different exporters', async () => {
    const body = payload(); body.data.result.push(body.data.result[0]!);
    expect(await source(body).query(signal)).toEqual({ status: 'unavailable', reason: 'ambiguous_series' });
  });
  it.each(['NaN', '+Inf', '-1', '1.5', ''])('rejects invalid counts %s', async (value) => {
    const body = payload(); body.data.result[0]!.value[1] = value;
    expect(await source(body).query(signal)).toEqual({ status: 'unavailable', reason: 'invalid_data' });
  });
  it('rejects stale windows even if scraped recently', async () => {
    const body = payload(); body.data.result[2]!.value[1] = '300'; body.data.result[3]!.value[1] = '600';
    expect(await source(body).query(signal)).toEqual({ status: 'unavailable', reason: 'stale_window' });
  });
  it('rejects data for a different scope', async () => {
    const body = payload(); body.data.result[0]!.metric.service = 'other';
    expect(await source(body).query(signal)).toEqual({ status: 'unavailable', reason: 'invalid_data' });
  });
  it('does not hide HTTP failures as healthy or missing data', async () => {
    const provider = new PrometheusSettlementSource({ url: 'http://localhost:9090', fetch: () => Promise.resolve(new Response('', { status: 503 })) });
    await expect(provider.query(signal)).rejects.toMatchObject({ code: 'PROMETHEUS_HTTP_ERROR' });
  });
  it('honors already cancelled requests', async () => {
    await expect(source(payload()).query(AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' });
  });
  it.each(['http://user:secret@localhost:9090', 'file:///tmp/data', 'http://localhost:9090/?query=anything'])('rejects unsafe configured URL %s', (url) => {
    expect(() => new PrometheusSettlementSource({ url })).toThrow('INVALID_PROMETHEUS_URL');
  });
  it('rejects malformed envelopes', async () => {
    expect(await source({ status: 'error', error: 'untrusted' }).query(signal)).toEqual({ status: 'unavailable', reason: 'invalid_data' });
  });
  it('rejects annotated partial results', async () => {
    expect(await source({ ...payload(), warnings: ['partial'] }).query(signal)).toEqual({ status: 'unavailable', reason: 'invalid_data' });
  });
  it('caps response bytes before parsing', async () => {
    const provider = new PrometheusSettlementSource({ url: 'http://localhost:9090', fetch: () => Promise.resolve(new Response('x'.repeat(65537))) });
    await expect(provider.query(signal)).rejects.toMatchObject({ code: 'PROMETHEUS_RESPONSE_TOO_LARGE' });
  });
  it('rejects malformed JSON without exposing its text', async () => {
    const provider = new PrometheusSettlementSource({ url: 'http://localhost:9090', fetch: () => Promise.resolve(new Response('secret:not json')) });
    await expect(provider.query(signal)).rejects.toMatchObject({ message: 'PROMETHEUS_INVALID_RESPONSE' });
  });
});
