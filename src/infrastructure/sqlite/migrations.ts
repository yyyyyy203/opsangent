import type Database from 'better-sqlite3';

const MIGRATIONS = [
  `
    CREATE TABLE agent_run_sequences (
      run_id TEXT PRIMARY KEY,
      current_sequence INTEGER NOT NULL CHECK (current_sequence >= 0)
    );
    CREATE TABLE agent_events (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      event_json TEXT NOT NULL,
      UNIQUE (run_id, sequence)
    );
    CREATE INDEX agent_events_run_sequence ON agent_events(run_id, sequence);
    CREATE INDEX agent_events_type_timestamp ON agent_events(type, timestamp);
    CREATE TABLE agent_messages (
      message_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version > 0),
      message_json TEXT NOT NULL
    );
    CREATE INDEX agent_messages_run ON agent_messages(run_id, message_id);
    CREATE TABLE projection_checkpoints (
      projector TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      PRIMARY KEY (projector, run_id)
    );
    CREATE TABLE projection_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      projector TEXT NOT NULL,
      error_code TEXT NOT NULL,
      message TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
] as const;

export function migrateSqlite(database: Database.Database): void {
  const current = database.pragma('user_version', { simple: true }) as number;
  if (current > MIGRATIONS.length) throw new Error(`SQLite schema version ${current} is newer than supported ${MIGRATIONS.length}`);
  for (let version = current + 1; version <= MIGRATIONS.length; version += 1) {
    const sql = MIGRATIONS[version - 1];
    if (sql === undefined) throw new Error(`Missing SQLite migration ${version}`);
    database.transaction(() => {
      database.exec(sql);
      database.pragma(`user_version = ${version}`);
    })();
  }
}
