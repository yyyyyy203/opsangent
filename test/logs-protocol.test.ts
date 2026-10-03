import { describe, expect, it } from 'vitest';
import {
  logsCloseSnapshotInput,
  logsCloseSnapshotInputJsonSchema,
  logsPageWireResultSchema,
  logsSearchPageInput,
  logsSearchPageInputJsonSchema,
} from '../src/mcp/logs-protocol.js';

const validPage = {
  service: 'checkout',
  start: '2026-10-03T00:00:00Z',
  end: '2026-10-03T00:05:00Z',
  requestId: 'capture-1',
};

describe('logs MCP page protocol', () => {
  it('rejects model supplied indices and query DSL', () => {
    expect(logsSearchPageInput.safeParse({
      service: 'checkout', start: '2026-10-03T00:00:00Z',
      end: '2026-10-03T00:05:00Z', index: '*', query: { match_all: {} },
    }).success).toBe(false);
  });

  it('rejects timestamps without a timezone or with an impossible calendar date', () => {
    expect(logsSearchPageInput.safeParse({ ...validPage, start: '2026-10-03T00:00:00' }).success).toBe(false);
    expect(logsSearchPageInput.safeParse({ ...validPage, start: '2026-02-30T00:00:00Z' }).success).toBe(false);
  });

  it('requires a new request ID for the first page', () => {
    expect(logsSearchPageInput.safeParse({
      service: 'checkout', start: validPage.start, end: validPage.end,
    }).success).toBe(false);
    expect(logsSearchPageInput.safeParse({ ...validPage, requestId: '' }).success).toBe(false);
  });

  it('requires cursor and snapshot ID together', () => {
    expect(logsSearchPageInput.safeParse({ ...validPage, cursor: 'next-page' }).success).toBe(false);
    expect(logsSearchPageInput.safeParse({ ...validPage, sourceSnapshotId: 'snapshot-1' }).success).toBe(false);
    expect(logsSearchPageInput.safeParse({
      service: 'checkout', start: validPage.start, end: validPage.end,
      cursor: 'next-page', sourceSnapshotId: 'snapshot-1',
    }).success).toBe(true);
  });

  it('bounds ordinary filters and the opaque cursor', () => {
    expect(logsSearchPageInput.safeParse({ ...validPage, traceId: 't'.repeat(257) }).success).toBe(false);
    expect(logsSearchPageInput.safeParse({ ...validPage, contains: 'x'.repeat(1_025) }).success).toBe(false);
    expect(logsSearchPageInput.safeParse({ ...validPage, level: 'x'.repeat(257) }).success).toBe(false);
    expect(logsSearchPageInput.safeParse({ ...validPage, cursor: 'c'.repeat(4_097), sourceSnapshotId: 'snapshot-1' }).success).toBe(false);
  });

  it('strictly validates snapshot-close input', () => {
    expect(logsCloseSnapshotInput.safeParse({ sourceSnapshotId: 'snapshot-1' }).success).toBe(true);
    expect(logsCloseSnapshotInput.safeParse({ sourceSnapshotId: '' }).success).toBe(false);
    expect(logsCloseSnapshotInput.safeParse({ sourceSnapshotId: 'snapshot-1', pitId: 'private-pit' }).success).toBe(false);
  });

  it('publishes stable bounded JSON Schemas for the read-only MCP tools', () => {
    expect(logsSearchPageInputJsonSchema).toMatchObject({
      type: 'object', additionalProperties: false,
      properties: { service: { minLength: 1 }, cursor: { maxLength: 4_096 } },
      required: ['service', 'start', 'end'],
    });
    expect(logsSearchPageInputJsonSchema.allOf).toHaveLength(3);
    expect(logsCloseSnapshotInputJsonSchema).toMatchObject({
      type: 'object', properties: { sourceSnapshotId: { minLength: 1 } },
      required: ['sourceSnapshotId'], additionalProperties: false,
    });
  });

  it('rejects unknown response and normalized-record fields', () => {
    const record = { timestamp: '2026-10-03T00:04:59Z', service: 'checkout', message: 'timeout' };
    expect(logsPageWireResultSchema.safeParse({
      status: 'available', records: [record], sourceSnapshotId: 'snapshot-1', unexpected: true,
    }).success).toBe(false);
    expect(logsPageWireResultSchema.safeParse({
      status: 'available', records: [{ ...record, index: 'private-index' }], sourceSnapshotId: 'snapshot-1',
    }).success).toBe(false);
  });

  it('rejects a page with more than 32 normalized records', () => {
    const record = { timestamp: '2026-10-03T00:04:59Z', service: 'checkout', message: 'timeout' };
    expect(logsPageWireResultSchema.safeParse({
      status: 'available', records: Array.from({ length: 33 }, () => record), sourceSnapshotId: 'snapshot-1',
    }).success).toBe(false);
  });

  it('rejects a normalized record larger than 8 KiB when UTF-8 encoded', () => {
    const record = {
      timestamp: '2026-10-03T00:04:59Z',
      service: 'checkout',
      message: '日志'.repeat(1_400),
    };
    expect(logsPageWireResultSchema.safeParse({
      status: 'available', records: [record], sourceSnapshotId: 'snapshot-1',
    }).success).toBe(false);
  });

  it('limits source errors to stable codes and reasons without arbitrary fields', () => {
    expect(logsPageWireResultSchema.safeParse({
      status: 'source_error', code: 'UNAVAILABLE', reason: 'snapshot_expired',
    }).success).toBe(true);
    expect(logsPageWireResultSchema.safeParse({
      status: 'source_error', code: 'MODEL_ERROR', reason: 'snapshot_expired',
    }).success).toBe(false);
    expect(logsPageWireResultSchema.safeParse({
      status: 'source_error', code: 'UNAVAILABLE', reason: 'snapshot_expired', message: 'raw exception',
    }).success).toBe(false);
  });
});
