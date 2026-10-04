import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { AgentEventEnvelopeV2, PublicEvidenceView } from '../contracts/index.js';
import { systemClock } from '../contracts/common.js';
import type { AcceptanceSnapshot } from '../acceptance/types.js';
import { SqliteDatabase } from '../infrastructure/sqlite/database.js';
import { SqliteDurableStateStore } from '../infrastructure/sqlite/durable-state-store.js';
import { SqliteEventMessageStore } from '../infrastructure/sqlite/event-message-store.js';
import { SqliteEvidenceManifestStore } from '../infrastructure/sqlite/blob-manifest-store.js';
import { SqliteInspectionQueryService } from '../infrastructure/sqlite/inspection-query-service.js';

const EVENT_PAGE_SIZE = 200;
const MAX_EVENTS = 5_000;
const MAX_EVENT_BYTES = 5_000_000;
const EVIDENCE_PAGE_SIZE = 50;
const MAX_EVIDENCE_ITEMS = 500;
const MAX_EVIDENCE_BYTES = 1_000_000;
const MAX_CHILD_RUNS = 2;

export type AcceptanceReaderErrorCode =
  | 'INVALID_DATA_DIRECTORY'
  | 'DATABASE_NOT_FOUND'
  | 'INVALID_DATABASE_FILE'
  | 'INVALID_RUN_ID'
  | 'RUN_NOT_FOUND'
  | 'INVALID_RUN_TREE'
  | 'SNAPSHOT_TOO_LARGE'
  | 'SNAPSHOT_READ_FAILED';

export class AcceptanceReaderError extends Error {
  public constructor(public readonly code: AcceptanceReaderErrorCode) {
    super(code);
    this.name = 'AcceptanceReaderError';
  }
}

/** Reads one completed local Run tree from an existing SQLite file without opening a runtime. */
export async function readAcceptanceSnapshot(input: {
  dataDirectory: string;
  runId: string;
}): Promise<AcceptanceSnapshot> {
  if (!isAbsolute(input.dataDirectory) || input.dataDirectory.includes('\0')) {
    throw new AcceptanceReaderError('INVALID_DATA_DIRECTORY');
  }
  if (typeof input.runId !== 'string' || input.runId.length < 1 || input.runId.length > 256
    || containsControlCharacter(input.runId)) {
    throw new AcceptanceReaderError('INVALID_RUN_ID');
  }

  const dataDirectory = resolve(input.dataDirectory);
  const databasePath = join(dataDirectory, 'agent.sqlite');
  await assertRegularPath(dataDirectory, 'INVALID_DATA_DIRECTORY');
  await assertRegularPath(databasePath, 'DATABASE_NOT_FOUND', 'INVALID_DATABASE_FILE');

  let database: SqliteDatabase | undefined;
  try {
    const canonicalDirectory = await realpath(dataDirectory);
    const canonicalDatabase = await realpath(databasePath);
    if (resolve(canonicalDirectory) !== dataDirectory || resolve(canonicalDatabase) !== databasePath) {
      throw new AcceptanceReaderError('INVALID_DATABASE_FILE');
    }

    database = SqliteDatabase.openReadOnly(databasePath);
    const checkpoints = new SqliteDurableStateStore(database, systemClock);
    const eventMessages = new SqliteEventMessageStore(database);
    const manifests = new SqliteEvidenceManifestStore(database);
    const queries = new SqliteInspectionQueryService(database, checkpoints, manifests, eventMessages);
    const parent = await queries.getRun(input.runId);
    if (parent === null) throw new AcceptanceReaderError('RUN_NOT_FOUND');
    if (parent.parentRunId !== undefined || parent.childRunIds.length > MAX_CHILD_RUNS
      || new Set(parent.childRunIds).size !== parent.childRunIds.length) {
      throw new AcceptanceReaderError('INVALID_RUN_TREE');
    }

    const children = [];
    for (const childRunId of parent.childRunIds) {
      const child = await queries.getRun(childRunId);
      if (child === null || child.parentRunId !== parent.runId) throw new AcceptanceReaderError('INVALID_RUN_TREE');
      children.push(child);
    }
    const runIds = [parent.runId, ...children.map((child) => child.runId)];
    const events = await readEvents(eventMessages, runIds);
    const evidence = await readEvidence(queries, runIds);
    return { parent, children, evidence, events };
  } catch (error) {
    if (error instanceof AcceptanceReaderError) throw error;
    throw new AcceptanceReaderError('SNAPSHOT_READ_FAILED');
  } finally {
    database?.close();
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

async function assertRegularPath(
  path: string,
  missingCode: AcceptanceReaderErrorCode,
  invalidCode: AcceptanceReaderErrorCode = missingCode,
): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new AcceptanceReaderError(missingCode);
  }
  if (stat.isSymbolicLink() || (path.endsWith('agent.sqlite') ? !stat.isFile() : !stat.isDirectory())) {
    throw new AcceptanceReaderError(invalidCode);
  }
}

async function readEvents(
  store: SqliteEventMessageStore,
  runIds: readonly string[],
): Promise<AgentEventEnvelopeV2[]> {
  const byId = new Map<string, AgentEventEnvelopeV2>();
  let totalBytes = 0;
  for (const runId of runIds) {
    let afterSequence = 0;
    for (;;) {
      const page = await store.readRun(runId, afterSequence, EVENT_PAGE_SIZE);
      if (byId.size + page.length > MAX_EVENTS) throw new AcceptanceReaderError('SNAPSHOT_TOO_LARGE');
      for (const event of page) {
        const serialized = JSON.stringify(event);
        totalBytes += Buffer.byteLength(serialized, 'utf8');
        if (totalBytes > MAX_EVENT_BYTES) throw new AcceptanceReaderError('SNAPSHOT_TOO_LARGE');
        const previous = byId.get(event.eventId);
        if (previous !== undefined && JSON.stringify(previous) !== serialized) {
          throw new AcceptanceReaderError('INVALID_RUN_TREE');
        }
        byId.set(event.eventId, event);
      }
      if (page.length < EVENT_PAGE_SIZE) break;
      const lastSequence = page.at(-1)?.sequence;
      if (lastSequence === undefined || lastSequence <= afterSequence) throw new AcceptanceReaderError('INVALID_RUN_TREE');
      afterSequence = lastSequence;
    }
  }
  return [...byId.values()];
}

async function readEvidence(
  queries: SqliteInspectionQueryService,
  runIds: readonly string[],
): Promise<PublicEvidenceView[]> {
  const byId = new Map<string, PublicEvidenceView>();
  let totalBytes = 0;
  for (const runId of runIds) {
    let cursor: string | undefined;
    for (;;) {
      const page = await queries.listEvidence(runId, {
        limit: EVIDENCE_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      for (const evidence of page.items) {
        totalBytes += Buffer.byteLength(JSON.stringify(evidence), 'utf8');
        if (byId.size >= MAX_EVIDENCE_ITEMS || totalBytes > MAX_EVIDENCE_BYTES) {
          throw new AcceptanceReaderError('SNAPSHOT_TOO_LARGE');
        }
        const previous = byId.get(evidence.evidenceId);
        if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(evidence)) {
          throw new AcceptanceReaderError('INVALID_RUN_TREE');
        }
        byId.set(evidence.evidenceId, evidence);
      }
      cursor = page.nextCursor;
      if (cursor === undefined) break;
    }
  }
  return [...byId.values()];
}
