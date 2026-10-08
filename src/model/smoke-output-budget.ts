export interface SmokeOutputBudgetSnapshot {
  readonly limit: number;
  /** Tokens held by in-flight requests or requests lacking trustworthy final usage. */
  readonly reserved: number;
  /** Actual output tokens charged by validated final usage. */
  readonly settled: number;
  readonly available: number;
  readonly reservations: number;
  readonly settlements: number;
  readonly rejected: number;
}

export interface SmokeOutputReservation {
  readonly maxOutputTokens: number;
}

/** A synchronous, per-smoke-run ledger. Handles are valid only in their issuing ledger. */
export class SmokeOutputBudget {
  private readonly pending = new WeakMap<SmokeOutputReservation, number>();
  private reserved = 0;
  private settled = 0;
  private reservations = 0;
  private settlements = 0;
  private rejected = 0;

  public constructor(public readonly limit: number = 5120) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5120) {
      throw new RangeError('Smoke output limit must be an integer from 1 through 5120.');
    }
  }

  public reserve(maxOutputTokens: number): SmokeOutputReservation | undefined {
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 1024) {
      throw new RangeError('Smoke output reservation must be an integer from 1 through 1024.');
    }
    if (maxOutputTokens > this.limit - this.reserved - this.settled) {
      this.rejected += 1;
      return undefined;
    }
    const reservation = Object.freeze({ maxOutputTokens });
    this.pending.set(reservation, maxOutputTokens);
    this.reserved += maxOutputTokens;
    this.reservations += 1;
    return reservation;
  }

  /** Called only with final usage validated by the observer; failed calls retain their full hold. */
  public settle(reservation: SmokeOutputReservation, outputTokens: number): boolean {
    const cap = this.pending.get(reservation);
    if (cap === undefined || !Number.isSafeInteger(outputTokens) || outputTokens < 0 || outputTokens > cap) return false;
    this.pending.delete(reservation);
    this.reserved -= cap;
    this.settled += outputTokens;
    this.settlements += 1;
    return true;
  }

  public snapshot(): SmokeOutputBudgetSnapshot {
    return {
      limit: this.limit, reserved: this.reserved, settled: this.settled,
      available: this.limit - this.reserved - this.settled,
      reservations: this.reservations, settlements: this.settlements, rejected: this.rejected,
    };
  }
}
