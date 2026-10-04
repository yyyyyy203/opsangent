/** Explicit, non-secret identity for a configured chat model. */
export interface ModelIdentity {
  readonly provider: string;
  readonly model: string;
}
