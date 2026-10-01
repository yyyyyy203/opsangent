import type {
  CheckpointStore,
  EvidenceManifestQueryStore,
  EvidenceManifestStore,
  EvidenceQueryStore,
  EvidenceStore,
  EventStore,
  InspectionQueryService,
  PublicEvidencePage,
  PublicEvidenceView,
  PublicRunDetail,
  PublicRunPage,
  PublicRunSummary,
  RunListOptions,
  StoredRunCheckpoint,
  VersionedCheckpointStore,
} from '../contracts/index.js';
import { publicEvidenceFromManifest, publicEvidenceFromRecord } from '../contracts/read-model.js';
import type { AgentContext } from '../contracts/context.js';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

type AnyCheckpointStore = CheckpointStore | VersionedCheckpointStore;
/** Read-side adapter used by the default in-memory runtime and focused tests. */
export class InMemoryInspectionQueryService implements InspectionQueryService {
  public constructor(
    private readonly events: EventStore,
    private readonly checkpoints: AnyCheckpointStore,
    private readonly evidence: EvidenceStore & EvidenceQueryStore,
    private readonly manifests?: EvidenceManifestStore & Partial<EvidenceManifestQueryStore>,
  ) {}

  public async listRuns(options: RunListOptions = {}): Promise<PublicRunPage> {
    const limit = pageLimit(options.limit);
    const cursor = options.cursor === undefined ? undefined : decodeRunCursor(options.cursor);
    if (cursor !== undefined && (cursor.profileId !== options.profileId || cursor.status !== options.status)) {
      throw new Error('run cursor does not match its filters');
    }
    const runIds = this.events.listRunIds === undefined ? [] : await this.events.listRunIds();
    const items: PublicRunSummary[] = [];
    for (const runId of runIds) {
      const detail = await this.getRun(runId);
      if (detail === null || (options.profileId !== undefined && detail.profileId !== options.profileId)
        || (options.status !== undefined && detail.status !== options.status)) continue;
      if (cursor !== undefined && !isAfterRunCursor(detail, cursor)) continue;
      items.push(detail);
    }
    items.sort(compareRuns);
    const page = items.slice(0, limit);
    const last = page.at(-1);
    return { items: page, ...(items.length > page.length && last !== undefined ? { nextCursor: encodeRunCursor(last, options) } : {}) };
  }

  public async getRun(runId: string): Promise<PublicRunDetail | null> {
    const loaded = await this.loadCheckpoint(runId);
    if (loaded === null) return null;
    const relation = await this.findRelation(runId);
    return toRunDetail(loaded, relation.parentRunId, relation.childRunIds);
  }

  public async listEvidence(runId: string, options: { cursor?: string; limit?: number } = {}): Promise<PublicEvidencePage> {
    const limit = pageLimit(options.limit);
    const cursor = options.cursor === undefined ? undefined : decodeEvidenceCursor(options.cursor);
    if (cursor !== undefined && cursor.runId !== runId) throw new Error('evidence cursor does not belong to this Run');
    const inlinePage = await this.evidence.listByRun(runId, { limit, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
    const manifestPage = this.manifests?.listVisibleByRun === undefined
      ? { items: [] }
      : await this.manifests.listVisibleByRun(runId, { limit, ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
    const items = [...inlinePage.items.map(publicEvidenceFromRecord), ...manifestPage.items.map(publicEvidenceFromManifest)]
      .sort(compareEvidence);
    const page = items.slice(0, limit);
    const last = page.at(-1);
    const hasMore = items.length > page.length || inlinePage.nextCursor !== undefined || manifestPage.nextCursor !== undefined;
    return { items: page, ...(hasMore && last !== undefined ? { nextCursor: encodeEvidenceCursor(last) } : {}) };
  }

  public async getEvidence(runId: string, evidenceId: string): Promise<PublicEvidenceView | null> {
    const inline = await this.evidence.get(evidenceId);
    if (inline !== null) return inline.runId === runId ? publicEvidenceFromRecord(inline) : null;
    const manifest = await this.manifests?.getVisible(evidenceId);
    return manifest === null || manifest === undefined || manifest.runId !== runId ? null : publicEvidenceFromManifest(manifest);
  }

  private async loadCheckpoint(runId: string): Promise<LoadedCheckpoint | null> {
    const loaded = await this.checkpoints.load(runId);
    if (loaded === null) return null;
    if (isStoredCheckpoint(loaded)) return { context: loaded.context, revision: loaded.revision, updatedAt: loaded.savedAt };
    return { context: loaded, updatedAt: loaded.budget.startedAt };
  }

  private async findRelation(runId: string): Promise<{ parentRunId?: string; childRunIds: string[] }> {
    const runIds = this.events.listRunIds === undefined ? [] : await this.events.listRunIds();
    const childRunIds: string[] = [];
    let parentRunId: string | undefined;
    for (const candidate of runIds) {
      let afterSequence = 0;
      for (;;) {
        const events = await this.events.readRun(candidate, afterSequence, MAX_PAGE_SIZE);
        if (events.length === 0) break;
        for (const event of events) {
          if (event.type !== 'SUBAGENT_STARTED') continue;
          if (event.payload.childRunId === runId) parentRunId = event.payload.parentRunId;
          if (event.payload.parentRunId === runId) childRunIds.push(event.payload.childRunId);
        }
        afterSequence = events[events.length - 1]!.sequence;
        if (events.length < MAX_PAGE_SIZE) break;
      }
    }
    return { ...(parentRunId === undefined ? {} : { parentRunId }), childRunIds: [...new Set(childRunIds)] };
  }
}

interface LoadedCheckpoint {
  context: AgentContext;
  revision?: number;
  updatedAt: string;
}

function toRunDetail(loaded: LoadedCheckpoint, parentRunId: string | undefined, childRunIds: readonly string[]): PublicRunDetail {
  const context = loaded.context;
  return {
    runId: context.runId,
    profileId: context.profileId,
    status: context.status,
    stage: context.stage,
    ...(loaded.revision === undefined ? {} : { revision: loaded.revision }),
    contextVersion: context.contextVersion,
    createdAt: context.budget.startedAt,
    updatedAt: loaded.updatedAt,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    evidenceIds: [...context.evidenceIds],
    missingEvidence: context.missingEvidence.map((item) => item.slice(0, 500)),
    childRunIds: [...childRunIds],
    ...(context.failure === undefined ? {} : {
      failure: { code: context.failure.code, message: context.failure.message.slice(0, 500), retryable: context.failure.retryable },
    }),
  };
}

function isStoredCheckpoint(value: AgentContext | StoredRunCheckpoint): value is StoredRunCheckpoint {
  return typeof value === 'object' && value !== null && 'context' in value && 'revision' in value;
}

function compareRuns(left: PublicRunSummary, right: PublicRunSummary): number {
  return right.updatedAt.localeCompare(left.updatedAt) || right.runId.localeCompare(left.runId);
}

function compareEvidence(left: PublicEvidenceView, right: PublicEvidenceView): number {
  return left.capturedAt.localeCompare(right.capturedAt) || left.evidenceId.localeCompare(right.evidenceId);
}

function isAfterRunCursor(item: PublicRunSummary, cursor: RunCursor): boolean {
  return item.updatedAt < cursor.updatedAt || (item.updatedAt === cursor.updatedAt && item.runId < cursor.runId);
}

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PAGE_SIZE) throw new RangeError(`page limit must be between 1 and ${MAX_PAGE_SIZE}`);
  return value;
}

interface RunCursor { updatedAt: string; runId: string; profileId?: string; status?: string }
interface EvidenceCursor { runId: string; capturedAt: string; evidenceId: string }

function encodeRunCursor(item: PublicRunSummary, options: RunListOptions): string {
  return encode({ updatedAt: item.updatedAt, runId: item.runId, ...(options.profileId === undefined ? {} : { profileId: options.profileId }), ...(options.status === undefined ? {} : { status: options.status }) });
}

function decodeRunCursor(value: string): RunCursor {
  const parsed = decode(value);
  if (!isRecord(parsed) || typeof parsed.updatedAt !== 'string' || typeof parsed.runId !== 'string') throw new Error('run cursor is invalid');
  return { updatedAt: parsed.updatedAt, runId: parsed.runId, ...(typeof parsed.profileId === 'string' ? { profileId: parsed.profileId } : {}), ...(typeof parsed.status === 'string' ? { status: parsed.status } : {}) };
}

function encodeEvidenceCursor(item: PublicEvidenceView): string {
  return encode({ runId: item.runId, capturedAt: item.capturedAt, evidenceId: item.evidenceId });
}

function decodeEvidenceCursor(value: string): EvidenceCursor {
  const parsed = decode(value);
  if (!isRecord(parsed) || typeof parsed.runId !== 'string' || typeof parsed.capturedAt !== 'string' || typeof parsed.evidenceId !== 'string') throw new Error('evidence cursor is invalid');
  return parsed as unknown as EvidenceCursor;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decode(value: string): unknown {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown; }
  catch { throw new Error('cursor is invalid'); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
