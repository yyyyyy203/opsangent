import { canonicalJson } from '../../src/contracts/stable-json.js';
import type { EvidenceSourcePage, NormalizedLogRecord } from '../../src/contracts/index.js';

export interface GeneratedLogPageOptions {
  totalBytes: number;
  pageBytes?: number;
  recordTargetBytes?: number;
  marker?: string;
}

export async function* generatedLogPages(options: GeneratedLogPageOptions): AsyncIterable<EvidenceSourcePage> {
  if (!Number.isSafeInteger(options.totalBytes) || options.totalBytes <= 0) throw new RangeError('totalBytes must be positive');
  const pageBytes = options.pageBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0) throw new RangeError('pageBytes must be positive');
  const recordTargetBytes = options.recordTargetBytes ?? 2 * 1024;
  if (!Number.isSafeInteger(recordTargetBytes) || recordTargetBytes <= 0) throw new RangeError('recordTargetBytes must be positive');
  const marker = options.marker ?? 'raw-log-marker';
  let remaining = options.totalBytes;
  let sequence = 0;
  while (remaining > 0) {
    const target = Math.min(pageBytes, remaining);
    const records: NormalizedLogRecord[] = [];
    let pageRemaining = target;
    while (pageRemaining > 0) {
      const minimum = recordBytes(makeRecord(0, marker, sequence));
      if (pageRemaining < minimum) {
        if (records.length === 0) throw new Error('Generated page cannot satisfy the requested byte size');
        const lastSequence = sequence - 1;
        const lastRecord = records[records.length - 1];
        if (lastRecord === undefined) throw new Error('Generated page has no previous record');
        const lastMinimum = recordBytes(makeRecord(0, marker, lastSequence));
        const lastBytes = recordBytes(lastRecord);
        records[records.length - 1] = makeRecord(lastBytes + pageRemaining - lastMinimum, marker, lastSequence);
        remaining -= pageRemaining;
        pageRemaining = 0;
        break;
      }
      const desiredBytes = Math.min(recordTargetBytes, pageRemaining);
      const record = makeRecord(desiredBytes - minimum, marker, sequence);
      const bytes = recordBytes(record);
      if (bytes !== desiredBytes || bytes > pageRemaining) throw new Error('Generated record did not meet the requested byte size');
      records.push(record);
      pageRemaining -= bytes;
      remaining -= bytes;
      sequence += 1;
    }
    yield {
      records,
      encodedBytes: target - pageRemaining,
      ...(remaining === 0 ? {} : { nextCursor: 'cursor-' + sequence }),
      sourceSnapshotId: 'snapshot-1',
    };
  }
}

function makeRecord(padding: number, marker: string, sequence: number): NormalizedLogRecord {
  return {
    timestamp: new Date(Date.UTC(2026, 8, 13, 0, 0, sequence % 60)).toISOString(),
    service: 'checkout',
    level: 'ERROR',
    exception: 'SettlementException',
    traceId: 'trace-' + sequence,
    message: marker + ':' + 'x'.repeat(Math.max(0, padding)),
  };
}

function recordBytes(record: NormalizedLogRecord): number {
  return Buffer.byteLength(canonicalJson(record) + '\n', 'utf8');
}
