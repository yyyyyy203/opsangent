export interface SerializableInterrupt {
  hookId: string;
  interruptType: string;
  toolCallId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  expiresAt?: string;
}

export interface ConfirmationDecision {
  runId: string;
  toolCallId: string;
  confirmed: boolean;
  actor: string;
  reason?: string;
  decidedAt: string;
}
