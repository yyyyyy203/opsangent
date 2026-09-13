import type { NormalizedLogRecord } from './storage.js';

/** Structured filters shared by ELK-backed and local evidence readers. */
export interface LogEvidenceFilter {
  service?: string;
  level?: string;
  exception?: string;
  traceId?: string;
  contains?: string;
}

export interface LogEvidenceReadPage {
  records: readonly NormalizedLogRecord[];
  nextCursor?: string;
}

export interface LogEvidenceAggregation {
  recordCount: number;
  levels: readonly { value: string; count: number }[];
  services: readonly { value: string; count: number }[];
  exceptionSignatures: readonly { value: string; count: number }[];
  traceIds: readonly string[];
}

/** Reader port used by log Tools; implementations own Blob/Manifest details. */
export interface LogEvidenceReader {
  search(input: {
    evidenceId: string;
    runId: string;
    filter?: LogEvidenceFilter;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<LogEvidenceReadPage>;
  aggregate(input: {
    evidenceId: string;
    runId: string;
    filter?: LogEvidenceFilter;
    topN: number;
    signal: AbortSignal;
  }): Promise<LogEvidenceAggregation>;
  readSlice(input: {
    evidenceId: string;
    runId: string;
    filter?: LogEvidenceFilter;
    cursor?: string;
    limit: number;
    signal: AbortSignal;
  }): Promise<LogEvidenceReadPage>;
}
