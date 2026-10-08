export type ExportDiagnosticCode =
  | 'TRACE_QUEUE_FULL'
  | 'TRACE_NETWORK_ERROR'
  | 'TRACE_HTTP_ERROR'
  | 'TRACE_LOCAL_AUDIT_REJECTED'
  | 'TRACE_REQUEST_TIMEOUT'
  | 'TRACE_FLUSH_TIMEOUT'
  | 'TRACE_PARENT_MISSING'
  | 'TRACE_PAYLOAD_DROPPED';

export interface ExportDiagnostics {
  readonly pending: number;
  readonly dropped: number;
  readonly counts: Readonly<Partial<Record<ExportDiagnosticCode, number>>>;
}

/** In-memory safe counters; never stores an error, URL, or request payload. */
export class ExportDiagnosticsRecorder {
  private readonly counts: Partial<Record<ExportDiagnosticCode, number>> = {};
  private pending = 0;
  private operationPending = 0;
  private activeSpans = 0;
  private activeRequests = 0;
  private dropped = 0;

  public record(code: ExportDiagnosticCode): void {
    this.counts[code] = (this.counts[code] ?? 0) + 1;
    if (code === 'TRACE_QUEUE_FULL' || code === 'TRACE_PAYLOAD_DROPPED') this.dropped += 1;
  }

  public setPending(value: number): void {
    this.operationPending = clampCount(value);
    this.refreshPending();
  }

  public setActiveSpans(value: number): void {
    this.activeSpans = clampCount(value);
    this.refreshPending();
  }

  public beginRequest(): void {
    this.activeRequests = clampCount(this.activeRequests + 1);
    this.refreshPending();
  }

  public endRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.refreshPending();
  }

  public snapshot(): ExportDiagnostics {
    return { pending: this.pending, dropped: this.dropped, counts: { ...this.counts } };
  }

  private refreshPending(): void {
    this.pending = clampCount(this.operationPending + this.activeSpans + this.activeRequests);
  }
}

function clampCount(value: number): number {
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value)));
}
