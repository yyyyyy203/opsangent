import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import Database from 'better-sqlite3';
import { parseMemoryScope } from '../../contracts/diagnostic-memory-schema.js';
import { parseEmbeddingSpace } from '../../contracts/memory-vector-schema.js';
import { canonicalJson } from '../../contracts/stable-json.js';
import { embeddingSpaceKey, normalizeMemoryVector } from '../../memory/vector/embedding-space.js';
import { memoryScopeKey } from '../../memory/memory-scope.js';
import { VectorExperimentError } from '../../memory/vector/vector-error.js';

export interface StoredVectorRow {
  space_key: string; scope_key: string; kind: string; memory_id: string;
  revision: number; digest: string; dimensions: number; vector_blob: Buffer; vector_sha256: string;
}
const schema = `
  CREATE TABLE vector_experiment_meta (
    space_key TEXT PRIMARY KEY, schema_version INTEGER NOT NULL CHECK(schema_version = 1),
    space_json TEXT NOT NULL, corpus_digest TEXT NOT NULL
  );
  CREATE TABLE memory_vector_rows (
    space_key TEXT NOT NULL REFERENCES vector_experiment_meta(space_key),
    scope_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind = 'episodic'), memory_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0), digest TEXT NOT NULL,
    dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 2 AND 4096),
    vector_blob BLOB NOT NULL, vector_sha256 TEXT NOT NULL,
    PRIMARY KEY(space_key, scope_key, kind, memory_id)
  );
`;

/** Dedicated experimental database, not the production persistence bundle. */
export class MemoryVectorDatabase {
  private closed = false;
  private constructor(public readonly raw: Database.Database) {}
  public static open(path: string): MemoryVectorDatabase {
    let raw: Database.Database | undefined;
    try {
      if (!isAbsolute(path)) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      raw = new Database(path);
      const version = raw.pragma('user_version', { simple: true }) as number;
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      if (version !== 0 && version !== 1) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      if (version === 0 && tables.length !== 0) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      if (version === 1 && (tables.length !== 2 || !tables.some(({ name }) => name === 'vector_experiment_meta')
        || !tables.some(({ name }) => name === 'memory_vector_rows'))) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      raw.pragma('journal_mode = WAL'); raw.pragma('foreign_keys = ON'); raw.pragma('busy_timeout = 5000');
      if (version === 0) {
        const connection = raw;
        raw.transaction(() => { connection.exec(schema); connection.pragma('user_version = 1'); }).immediate();
      }
      const count = raw.prepare('SELECT COUNT(*) n, COALESCE(SUM(length(vector_blob)),0) bytes FROM memory_vector_rows').get() as { n: number; bytes: number };
      if (count.n > 1000 || count.bytes > 16 * 1024 * 1024) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      const spaces = raw.prepare('SELECT space_key, schema_version, space_json, corpus_digest FROM vector_experiment_meta').all() as {
        space_key: string; schema_version: number; space_json: string; corpus_digest: string;
      }[];
      if (spaces.length > 1000) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      const dimensions = new Map<string, number>();
      for (const row of spaces) {
        const space = parseEmbeddingSpace(JSON.parse(row.space_json) as unknown);
        if (row.schema_version !== 1 || embeddingSpaceKey(space) !== row.space_key || !isDigest(row.corpus_digest)) {
          throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
        }
        dimensions.set(row.space_key, space.dimensions);
        const identities = raw.prepare(`SELECT scope_key, kind, memory_id, revision, digest FROM memory_vector_rows
          WHERE space_key = ? ORDER BY scope_key, kind, memory_id`).all(row.space_key);
        if (createHash('sha256').update(canonicalJson(identities)).digest('hex') !== row.corpus_digest) {
          throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
        }
      }
      // Bounded row-by-row integrity check, never an unbounded in-memory vector cache.
      for (const value of raw.prepare('SELECT * FROM memory_vector_rows').iterate()) {
        const row = value as StoredVectorRow;
        if (dimensions.get(row.space_key) !== row.dimensions
          || memoryScopeKey(parseMemoryScope(JSON.parse(row.scope_key) as unknown)) !== row.scope_key) {
          throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
        }
        decodeStoredMemoryVector(row);
      }
      return new MemoryVectorDatabase(raw);
    } catch {
      raw?.close();
      throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
    }
  }
  public close(): void { if (!this.closed) { this.closed = true; this.raw.close(); } }
}

export function encodeMemoryVector(vector: Float32Array): Buffer {
  const bytes = Buffer.alloc(vector.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  vector.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

export function decodeStoredMemoryVector(row: StoredVectorRow): Float32Array {
  if (!Buffer.isBuffer(row.vector_blob) || !Number.isInteger(row.dimensions) || row.dimensions < 2 || row.dimensions > 4096
    || row.vector_blob.length !== row.dimensions * 4 || !isDigest(row.vector_sha256) || !isDigest(row.digest)
    || !Number.isSafeInteger(row.revision) || row.revision <= 0 || row.kind !== 'episodic'
    || !validVectorIdentifier(row.memory_id) || createHash('sha256').update(row.vector_blob).digest('hex') !== row.vector_sha256) {
    throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
  }
  const view = new DataView(row.vector_blob.buffer, row.vector_blob.byteOffset, row.vector_blob.byteLength);
  const vector = Float32Array.from({ length: row.dimensions }, (_, index) => view.getFloat32(index * 4, true));
  try {
    normalizeMemoryVector(vector, row.dimensions);
    if (Math.abs(Math.hypot(...vector) - 1) > 0.00001) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
    return vector;
  } catch { throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE'); }
}
export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}
export function validVectorIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim().length > 0;
}
