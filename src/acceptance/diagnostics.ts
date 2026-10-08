import { z } from 'zod';
import { containsSensitivePublicContent } from './privacy-audit.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u)
  .refine((value) => !containsSensitivePublicContent(value));
const modelDecisionSchema = z.object({
  runId: identifier, stepId: identifier, streamId: identifier.optional(),
  phase: z.enum(['query', 'report', 'summary']), maxOutputTokens: z.union([z.literal(512), z.literal(1024)]),
}).strict().refine((value) => value.maxOutputTokens === (value.phase === 'query' ? 512 : 1024));
const traceRequestSchema = z.object({
  route: z.enum(['info', 'batch', 'multipart']),
  phase: z.enum(['audit', 'send', 'headers', 'body', 'complete']),
  outcome: z.enum(['ok', 'local_reject', 'http_error', 'timeout', 'aborted', 'network_error']),
  elapsedMs: count, httpStatus: z.number().int().min(100).max(599).optional(),
}).strict();
const traceVerificationSchema = z.object({
  phase: z.enum(['local_snapshot', 'local_links', 'remote_query', 'remote_compare', 'complete']),
  reason: z.enum(['verified', 'invalid_local_tree', 'invalid_source_invocation', 'missing_link', 'invalid_link',
    'remote_unavailable', 'remote_mismatch', 'usage_unavailable', 'usage_mismatch']),
  remoteQueriesSent: count.max(3),
}).strict();
const diagnosticsSchema = z.object({
  modelDecisions: z.array(modelDecisionSchema).max(16),
  traceRequests: z.array(traceRequestSchema).max(64),
  traceVerification: traceVerificationSchema.optional(),
  dropped: z.object({ modelDecisions: count, traceRequests: count }).strict().optional(),
}).strict();

export type SmokeModelDecision = Readonly<z.infer<typeof modelDecisionSchema>>;
export type TraceRequestDiagnostic = Readonly<z.infer<typeof traceRequestSchema>>;
export type TraceVerificationDiagnostic = Readonly<z.infer<typeof traceVerificationSchema>>;
export interface AcceptanceDiagnostics {
  readonly modelDecisions: readonly SmokeModelDecision[];
  readonly traceRequests: readonly TraceRequestDiagnostic[];
  readonly traceVerification?: TraceVerificationDiagnostic;
  readonly dropped?: { readonly modelDecisions: number; readonly traceRequests: number };
}

/** The local artifact boundary is strict: never silently strip unknown diagnostics. */
export function parseAcceptanceDiagnostics(value: unknown, sensitiveValues: readonly string[] = []): AcceptanceDiagnostics {
  const parsed = diagnosticsSchema.safeParse(value);
  if (!parsed.success || containsSensitivePublicContent(JSON.stringify(parsed.data), sensitiveValues)) {
    throw new Error('ACCEPTANCE_DIAGNOSTICS_INVALID');
  }
  const data = parsed.data;
  return { modelDecisions: data.modelDecisions, traceRequests: data.traceRequests,
    ...(data.traceVerification === undefined ? {} : { traceVerification: data.traceVerification }),
    ...(data.dropped === undefined ? {} : { dropped: data.dropped }),
  };
}

/** Per-acceptance-run state, bounded independently of exporter SDK queue size. */
export class AcceptanceDiagnosticsRecorder {
  private readonly decisions: SmokeModelDecision[] = [];
  private readonly requests: TraceRequestDiagnostic[] = [];
  private verification: TraceVerificationDiagnostic | undefined;
  private droppedDecisions = 0;
  private droppedRequests = 0;

  public recordModelDecision(value: SmokeModelDecision): void {
    const parsed = modelDecisionSchema.safeParse(value);
    if (!parsed.success) throw new Error('ACCEPTANCE_DIAGNOSTICS_INVALID');
    if (this.decisions.length < 16) this.decisions.push(parsed.data);
    else this.droppedDecisions = increment(this.droppedDecisions);
  }

  public recordTraceRequest(value: TraceRequestDiagnostic): void {
    const parsed = traceRequestSchema.safeParse(value);
    if (!parsed.success) throw new Error('ACCEPTANCE_DIAGNOSTICS_INVALID');
    if (this.requests.length < 64) this.requests.push(parsed.data);
    else this.droppedRequests = increment(this.droppedRequests);
  }

  public recordTraceVerification(value: TraceVerificationDiagnostic): void {
    const parsed = traceVerificationSchema.safeParse(value);
    if (!parsed.success) throw new Error('ACCEPTANCE_DIAGNOSTICS_INVALID');
    this.verification = parsed.data;
  }

  public snapshot(): AcceptanceDiagnostics {
    return {
      modelDecisions: this.decisions.map((value) => ({ ...value })),
      traceRequests: this.requests.map((value) => ({ ...value })),
      ...(this.verification === undefined ? {} : { traceVerification: { ...this.verification } }),
      ...(this.droppedDecisions + this.droppedRequests === 0 ? {} : {
        dropped: { modelDecisions: this.droppedDecisions, traceRequests: this.droppedRequests },
      }),
    };
  }
}

function increment(value: number): number { return Math.min(Number.MAX_SAFE_INTEGER, value + 1); }
