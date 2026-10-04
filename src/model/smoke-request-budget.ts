export interface SmokeBudgetSnapshot {
  readonly limit: number;
  readonly attempted: number;
  readonly sent: number;
  readonly rejected: number;
}

/** Synchronous reservation ledger shared by all model calls in one smoke run. */
export class SmokeRequestBudget {
  private attempted = 0;
  private sent = 0;
  private rejected = 0;
  private reserved = 0;
  private allocated = 0;

  public constructor(public readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new RangeError('Smoke request limit must be an integer from 1 through 10.');
    }
  }

  /** Counts every attempted request and atomically reserves a network-send slot. */
  public reserve(): boolean {
    this.attempted += 1;
    if (this.allocated >= this.limit) {
      this.rejected += 1;
      return false;
    }
    this.allocated += 1;
    this.reserved += 1;
    return true;
  }

  /** Releases a local reservation as rejected; consumed capacity is not refunded. */
  public rejectReserved(): void {
    if (this.reserved <= 0) throw new RangeError('No reserved smoke request can be rejected.');
    this.reserved -= 1;
    this.rejected += 1;
  }

  /** Marks the request as sent immediately before calling the network transport. */
  public markSent(): void {
    if (this.reserved <= 0 || this.sent >= this.limit) {
      throw new RangeError('No reserved smoke request can be sent.');
    }
    this.reserved -= 1;
    this.sent += 1;
  }

  public snapshot(): SmokeBudgetSnapshot {
    return {
      limit: this.limit,
      attempted: this.attempted,
      sent: this.sent,
      rejected: this.rejected,
    };
  }
}
