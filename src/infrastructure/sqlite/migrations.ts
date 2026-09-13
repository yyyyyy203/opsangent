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
  `
    CREATE TABLE agent_checkpoints (
      run_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision > 0),
      context_version INTEGER NOT NULL CHECK (context_version > 0),
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      checkpoint_schema_version INTEGER NOT NULL CHECK (checkpoint_schema_version > 0),
      checkpoint_json TEXT NOT NULL,
      checksum TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX agent_checkpoints_status_updated ON agent_checkpoints(status, updated_at);

    CREATE TABLE evidence_records (
      evidence_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      tool_call_id TEXT,
      capture_key TEXT UNIQUE,
      source TEXT NOT NULL CHECK (source IN ('metric', 'log', 'trace', 'change')),
      captured_at TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      raw_sha256 TEXT NOT NULL,
      business_trace_ids_json TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version > 0)
    );
    CREATE INDEX evidence_records_run_captured ON evidence_records(run_id, captured_at, evidence_id);
    CREATE INDEX evidence_records_source_captured ON evidence_records(source, captured_at, evidence_id);

    CREATE TABLE tool_executions (
      tool_call_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_kind TEXT NOT NULL CHECK (tool_kind IN ('evidence', 'action', 'utility')),
      input_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'succeeded', 'failed', 'uncertain')),
      result_json TEXT,
      reason_code TEXT,
      prepared_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX tool_executions_run_state ON tool_executions(run_id, state, tool_call_id);
  `,
  `
    CREATE TABLE durable_event_outbox (
      event_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'published')),
      created_at TEXT NOT NULL,
      published_at TEXT
    );
    CREATE INDEX durable_event_outbox_pending_run
      ON durable_event_outbox(state, run_id, event_id);
  `,
  [
    'CREATE TABLE evidence_blob_manifests (',
    '  manifest_id TEXT PRIMARY KEY,',
    '  evidence_id TEXT NOT NULL UNIQUE,',
    '  run_id TEXT NOT NULL,',
    '  step_id TEXT NOT NULL,',
    '  tool_call_id TEXT NOT NULL,',
    '  capture_key TEXT NOT NULL UNIQUE,',
    "  source TEXT NOT NULL CHECK (source IN ('log', 'trace')),",
    '  query_digest TEXT NOT NULL,',
    '  source_snapshot_id TEXT,',
    '  range_start TEXT NOT NULL,',
    '  range_end TEXT NOT NULL,',
    "  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'partial', 'failed', 'deleting')),",
    '  record_count INTEGER NOT NULL DEFAULT 0,',
    '  source_bytes INTEGER NOT NULL DEFAULT 0,',
    '  stored_bytes INTEGER NOT NULL DEFAULT 0,',
    "  compression TEXT NOT NULL CHECK (compression = 'gzip_ndjson'),",
    '  next_cursor TEXT,',
    '  truncated INTEGER NOT NULL DEFAULT 0,',
    '  coverage REAL NOT NULL DEFAULT 0,',
    "  raw_sha256 TEXT NOT NULL DEFAULT '',",
    '  summary_json TEXT,',
    "  missing_evidence_json TEXT NOT NULL DEFAULT '[]',",
    '  failure_reason_code TEXT,',
    '  redaction_policy_version TEXT NOT NULL,',
    '  retention_until TEXT,',
    '  created_at TEXT NOT NULL,',
    '  updated_at TEXT NOT NULL,',
    '  committed_at TEXT',
    ');',
    'CREATE TABLE evidence_blob_chunks (',
    '  manifest_id TEXT NOT NULL,',
    '  chunk_index INTEGER NOT NULL,',
    '  storage_key TEXT NOT NULL UNIQUE,',
    '  record_count INTEGER NOT NULL,',
    '  source_bytes INTEGER NOT NULL,',
    '  stored_bytes INTEGER NOT NULL,',
    '  sha256 TEXT NOT NULL,',
    '  first_captured_at TEXT,',
    '  last_captured_at TEXT,',
    '  committed_at TEXT NOT NULL,',
    '  PRIMARY KEY (manifest_id, chunk_index),',
    '  FOREIGN KEY (manifest_id) REFERENCES evidence_blob_manifests(manifest_id) ON DELETE RESTRICT',
    ');',
    'CREATE INDEX evidence_blob_manifests_run_time ON evidence_blob_manifests(run_id, range_start, range_end);',
    'CREATE INDEX evidence_blob_manifests_state_updated ON evidence_blob_manifests(state, updated_at);',
  ].join('\n'),
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
