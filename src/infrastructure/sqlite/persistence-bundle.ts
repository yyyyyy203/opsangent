import { systemClock, type Clock, type IdGenerator } from '../../contracts/common.js';
import type { EventStore, MessageStore } from '../../contracts/event-store.js';
import type {
  AgentStateUnitOfWork,
  DurableEventOutbox,
  DurableTransitionUnitOfWork,
  EvidenceBlobStore,
  EvidenceManifestStore,
  EvidenceQueryStore,
  EvidenceStore,
  ToolExecutionJournal,
  VersionedCheckpointStore,
} from '../../contracts/storage.js';
import type { ProjectionCheckpointStoreV2 } from '../../event/v2/projection-runner.js';
import type { ProjectionFailureSinkV2 } from '../../event/v2/event-publisher.js';
import { SqliteDatabase } from './database.js';
import { SqliteDurableStateStore } from './durable-state-store.js';
import { SqliteEventOutboxStore } from './event-outbox-store.js';
import { SqliteEventMessageStore } from './event-message-store.js';
import { SqliteProjectionCheckpointStore, SqliteProjectionFailureSink } from './projection-store.js';
import { SqliteEvidenceStore } from './sqlite-evidence-store.js';
import { SqliteEvidenceManifestStore } from './blob-manifest-store.js';
import { LocalEvidenceBlobStore } from '../blob/local-evidence-blob-store.js';

export interface SqlitePersistenceLimits {
  maxEvidenceRawBytes?: number;
}

export interface CreateSqlitePersistenceOptions {
  path: string;
  clock?: Clock;
  limits?: SqlitePersistenceLimits;
  evidenceBlobRootPath?: string;
  ids?: IdGenerator;
}

/** Single ownership boundary for all SQLite-backed Agent state. */
export interface SqlitePersistenceBundle {
  checkpoints: VersionedCheckpointStore;
  executions: ToolExecutionJournal;
  stateUnitOfWork: AgentStateUnitOfWork;
  transitions: DurableTransitionUnitOfWork;
  outbox: DurableEventOutbox;
  evidence: EvidenceStore & EvidenceQueryStore;
  evidenceManifests: EvidenceManifestStore;
  evidenceBlobs?: EvidenceBlobStore;
  eventMessages: EventStore & MessageStore;
  projectionCheckpoints: ProjectionCheckpointStoreV2;
  projectionFailures: ProjectionFailureSinkV2;
  close(): void;
}

export function createSqlitePersistence(options: CreateSqlitePersistenceOptions): SqlitePersistenceBundle {
  const database = SqliteDatabase.open(options.path);
  try {
    const clock = options.clock ?? systemClock;
    const durable = new SqliteDurableStateStore(database, clock);
    const outbox = new SqliteEventOutboxStore(database);
    const eventMessages = new SqliteEventMessageStore(database);
    const evidence = new SqliteEvidenceStore(database, {
      ...(options.limits?.maxEvidenceRawBytes === undefined ? {} : { maxRawBytes: options.limits.maxEvidenceRawBytes }),
    });
    const evidenceManifests = new SqliteEvidenceManifestStore(database);
    const evidenceBlobs = options.evidenceBlobRootPath === undefined
      ? undefined
      : new LocalEvidenceBlobStore({
        rootPath: options.evidenceBlobRootPath,
        ...(options.clock === undefined ? {} : { clock }),
        ...(options.ids === undefined ? {} : { ids: options.ids }),
      });
    let closed = false;
    return {
      checkpoints: durable,
      executions: durable,
      stateUnitOfWork: durable,
      transitions: durable,
      outbox,
      evidence,
      evidenceManifests,
      ...(evidenceBlobs === undefined ? {} : { evidenceBlobs }),
      eventMessages,
      projectionCheckpoints: new SqliteProjectionCheckpointStore(database),
      projectionFailures: new SqliteProjectionFailureSink(database, () => clock.now().toISOString()),
      close: () => {
        if (closed) return;
        closed = true;
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
