import type { ProjectionFailureRecordV2, ProjectionFailureSinkV2 } from '../../event/v2/event-publisher.js';
import { ProjectionCheckpointConflictError, type ProjectionCheckpointStoreV2 } from '../../event/v2/projection-runner.js';
import type { SqliteDatabase } from './database.js';

interface CheckpointRow { sequence: number }

export class SqliteProjectionCheckpointStore implements ProjectionCheckpointStoreV2 {
  public constructor(private readonly database: SqliteDatabase) {}

  public load(projector: string, runId: string): Promise<number> {
    return Promise.resolve().then(() => {
      const row = this.database.raw.prepare('SELECT sequence FROM projection_checkpoints WHERE projector = ? AND run_id = ?')
        .get(projector, runId) as CheckpointRow | undefined;
      return row?.sequence ?? 0;
    });
  }

  public save(projector: string, runId: string, expectedSequence: number, sequence: number): Promise<void> {
    return Promise.resolve().then(() => this.database.raw.transaction(() => {
      const row = this.database.raw.prepare('SELECT sequence FROM projection_checkpoints WHERE projector = ? AND run_id = ?')
        .get(projector, runId) as CheckpointRow | undefined;
      const actual = row?.sequence ?? 0;
      if (actual !== expectedSequence) throw new ProjectionCheckpointConflictError(projector, runId, expectedSequence, actual);
      if (!Number.isSafeInteger(sequence) || sequence <= actual) throw new RangeError('projection sequence must advance');
      this.database.raw.prepare(`
        INSERT INTO projection_checkpoints(projector, run_id, sequence) VALUES (?, ?, ?)
        ON CONFLICT(projector, run_id) DO UPDATE SET sequence=excluded.sequence
      `).run(projector, runId, sequence);
    }).immediate());
  }
}

export class SqliteProjectionFailureSink implements ProjectionFailureSinkV2 {
  public constructor(private readonly database: SqliteDatabase, private readonly now: () => string = () => new Date().toISOString()) {}

  public record(failure: ProjectionFailureRecordV2): Promise<void> {
    return Promise.resolve().then(() => {
      this.database.raw.prepare(`
        INSERT INTO projection_failures(event_id, run_id, sequence, projector, error_code, message, attempts, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(failure.eventId, failure.runId, failure.sequence, failure.projector, failure.errorCode, failure.message, failure.attempts, this.now());
    });
  }
}
