import { createHash } from 'node:crypto';
import type { Clock } from '../../contracts/common.js';
import type { MemoryOperation, MemoryScope } from '../../contracts/diagnostic-memory.js';
import type { EmbeddingSpace, MemoryVectorEntry, MemoryVectorHit, MemoryVectorSearch, VectorIndex } from '../../contracts/memory-vector.js';
import { parseMemoryScope } from '../../contracts/diagnostic-memory-schema.js';
import { parseEmbeddingSpace } from '../../contracts/memory-vector-schema.js';
import { canonicalJson } from '../../contracts/stable-json.js';
import { embeddingSpaceKey, normalizeMemoryVector } from '../../memory/vector/embedding-space.js';
import { memoryScopeKey } from '../../memory/memory-scope.js';
import { VectorExperimentError } from '../../memory/vector/vector-error.js';
import { decodeStoredMemoryVector, encodeMemoryVector, isDigest, validVectorIdentifier,
  type MemoryVectorDatabase, type StoredVectorRow } from './memory-vector-database.js';

export class SqliteVectorIndex implements VectorIndex {
  private closed = false;
  private readonly database: MemoryVectorDatabase;
  private readonly clock: Clock;
  public constructor(options: { database: MemoryVectorDatabase; clock: Clock }) {
    this.database = options.database; this.clock = options.clock;
  }

  public upsert(entries: readonly MemoryVectorEntry[], operation: MemoryOperation): Promise<void> {
    return this.perform(operation, () => {
      assertBoundedArray(entries, 16);
      const identities = new Set<string>();
      const rows = entries.map((entry) => {
        this.checkBudget(operation);
        this.validateSelection(entry);
        if (entry.kind !== 'episodic') throw new VectorExperimentError('VECTOR_INPUT_INVALID');
        const space = this.parseSpace(entry.space);
        const scopeKey = this.parseScopeKey(entry.scope);
        const spaceKey = embeddingSpaceKey(space);
        const identity = canonicalJson([spaceKey, scopeKey, entry.kind, entry.memoryId]);
        if (identities.has(identity)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
        identities.add(identity);
        const bytes = encodeMemoryVector(normalizeMemoryVector(entry.vector, space.dimensions));
        return { entry, space, scopeKey, spaceKey, bytes, sha: createHash('sha256').update(bytes).digest('hex') };
      });
      this.database.raw.transaction(() => {
        const affectedSpaces = new Set<string>();
        let additions = 0;
        for (const row of rows) {
          this.checkBudget(operation);
          const stored = this.database.raw.prepare(`SELECT * FROM memory_vector_rows
            WHERE space_key = ? AND scope_key = ? AND kind = 'episodic' AND memory_id = ?`).get(row.spaceKey, row.scopeKey, row.entry.memoryId) as StoredVectorRow | undefined;
          if (stored === undefined) { additions += 1; continue; }
          decodeStoredMemoryVector(stored);
          if (row.entry.revision < stored.revision || (row.entry.revision === stored.revision
            && (row.entry.digest !== stored.digest || row.sha !== stored.vector_sha256))) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
        }
        const count = this.database.raw.prepare('SELECT COUNT(*) n FROM memory_vector_rows').get() as { n: number };
        if (count.n + additions > 1000) throw new VectorExperimentError('VECTOR_CAPACITY_EXCEEDED');
        for (const row of rows) {
          this.validateSpaceDescriptor(row.spaceKey, row.space);
          this.database.raw.prepare(`INSERT INTO vector_experiment_meta(space_key, schema_version, space_json, corpus_digest)
            VALUES (?, 1, ?, ?) ON CONFLICT(space_key) DO NOTHING`).run(row.spaceKey, canonicalJson(row.space), createHash('sha256').update('[]').digest('hex'));
          this.database.raw.prepare(`INSERT INTO memory_vector_rows
            (space_key, scope_key, kind, memory_id, revision, digest, dimensions, vector_blob, vector_sha256)
            VALUES (?, ?, 'episodic', ?, ?, ?, ?, ?, ?)
            ON CONFLICT(space_key, scope_key, kind, memory_id) DO UPDATE SET revision=excluded.revision,
              digest=excluded.digest, dimensions=excluded.dimensions, vector_blob=excluded.vector_blob, vector_sha256=excluded.vector_sha256`)
            .run(row.spaceKey, row.scopeKey, row.entry.memoryId, row.entry.revision, row.entry.digest, row.space.dimensions, row.bytes, row.sha);
          affectedSpaces.add(row.spaceKey);
        }
        for (const spaceKey of affectedSpaces) this.updateCorpusDigest(spaceKey);
        this.checkBudget(operation);
      }).immediate();
    });
  }

  public search(input: MemoryVectorSearch, operation: MemoryOperation): Promise<readonly MemoryVectorHit[]> {
    return this.perform(operation, () => {
      const space = this.parseSpace(input.space);
      const spaceKey = embeddingSpaceKey(space);
      const scopeKey = this.parseScopeKey(input.scope);
      const vector = normalizeMemoryVector(input.vector, space.dimensions);
      const limit = input.limit ?? 5;
      assertBoundedArray(input.eligible, 1000);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      }
      const ids = new Set<string>();
      const eligible = input.eligible.map((item) => {
        this.validateSelection(item);
        if (ids.has(item.memoryId)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
        ids.add(item.memoryId);
        return { memoryId: item.memoryId, revision: item.revision, digest: item.digest };
      });
      this.validateSpaceDescriptor(spaceKey, space);
      const where = `FROM memory_vector_rows v JOIN json_each(@eligible) e
        ON v.memory_id = json_extract(e.value, '$.memoryId')
        AND v.revision = json_extract(e.value, '$.revision') AND v.digest = json_extract(e.value, '$.digest')
        WHERE v.scope_key = @scopeKey AND v.space_key = @spaceKey AND v.kind = 'episodic'`;
      const parameters = { eligible: JSON.stringify(eligible), scopeKey, spaceKey };
      const size = this.database.raw.prepare(`SELECT COUNT(*) n, COALESCE(SUM(length(v.vector_blob)),0) bytes ${where}`)
        .get(parameters) as { n: number; bytes: number };
      if (size.n > 1000 || size.bytes > 16 * 1024 * 1024) throw new VectorExperimentError('VECTOR_CAPACITY_EXCEEDED');
      const hits: MemoryVectorHit[] = [];
      let count = 0;
      for (const value of this.database.raw.prepare(`SELECT v.* ${where}`).iterate(parameters)) {
        if (count++ % 64 === 0) this.checkBudget(operation);
        const row = value as StoredVectorRow;
        if (row.dimensions !== space.dimensions) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
        const stored = decodeStoredMemoryVector(row);
        let score = 0;
        for (let dimension = 0; dimension < stored.length; dimension += 1) score += (stored[dimension] ?? 0) * (vector[dimension] ?? 0);
        if (!Number.isFinite(score)) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
        hits.push({ memoryId: row.memory_id, revision: row.revision, digest: row.digest, score });
      }
      this.checkBudget(operation);
      return hits.sort((left, right) => right.score - left.score
        || Buffer.compare(Buffer.from(left.memoryId), Buffer.from(right.memoryId))).slice(0, limit);
    });
  }

  public remove(input: { scope: MemoryScope; space: EmbeddingSpace; memoryIds: readonly string[] }, operation: MemoryOperation): Promise<void> {
    return this.perform(operation, () => {
      const spaceKey = embeddingSpaceKey(this.parseSpace(input.space));
      const scopeKey = this.parseScopeKey(input.scope);
      assertBoundedArray(input.memoryIds, 1000);
      if (input.memoryIds.some((id) => !validVectorIdentifier(id))) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
      this.database.raw.transaction(() => {
        this.database.raw.prepare(`DELETE FROM memory_vector_rows
          WHERE space_key = ? AND scope_key = ? AND kind = 'episodic' AND memory_id IN (SELECT value FROM json_each(?))`)
          .run(spaceKey, scopeKey, JSON.stringify(input.memoryIds));
        this.updateCorpusDigest(spaceKey);
        this.checkBudget(operation);
      }).immediate();
    });
  }

  public close(): Promise<void> { this.closed = true; return Promise.resolve(); }

  private perform<T>(operation: MemoryOperation, action: () => T): Promise<T> {
    return Promise.resolve().then(() => {
      this.checkBudget(operation);
      try { return action(); } catch (error) {
        if (error instanceof VectorExperimentError || (error instanceof DOMException
          && (error.name === 'AbortError' || error.name === 'TimeoutError')) || operation.signal?.aborted) throw error;
        throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      }
    });
  }
  private checkBudget(operation: MemoryOperation): void {
    operation.signal?.throwIfAborted();
    if (this.closed) throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
    if (!Number.isFinite(operation.deadlineMs)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
    if (this.clock.now().getTime() >= operation.deadlineMs) throw new DOMException('Vector deadline exceeded.', 'TimeoutError');
  }
  private validateSelection(value: { memoryId: string; revision: number; digest: string }): void {
    if (!validVectorIdentifier(value.memoryId) || !Number.isSafeInteger(value.revision) || value.revision <= 0 || !isDigest(value.digest)) {
      throw new VectorExperimentError('VECTOR_INPUT_INVALID');
    }
  }
  private parseSpace(space: EmbeddingSpace): EmbeddingSpace {
    try { return parseEmbeddingSpace(space); } catch { throw new VectorExperimentError('VECTOR_INPUT_INVALID'); }
  }
  private parseScopeKey(scope: MemoryScope): string {
    try { return memoryScopeKey(parseMemoryScope(scope)); } catch { throw new VectorExperimentError('VECTOR_INPUT_INVALID'); }
  }
  private validateSpaceDescriptor(key: string, expected: EmbeddingSpace): void {
    const stored = this.database.raw.prepare('SELECT space_json, corpus_digest, schema_version FROM vector_experiment_meta WHERE space_key = ?')
      .get(key) as { space_json: string; corpus_digest: string; schema_version: number } | undefined;
    if (stored === undefined) return;
    try {
      if (stored.schema_version !== 1 || !isDigest(stored.corpus_digest)
        || embeddingSpaceKey(parseEmbeddingSpace(JSON.parse(stored.space_json) as unknown)) !== embeddingSpaceKey(expected)) {
        throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE');
      }
    } catch { throw new VectorExperimentError('VECTOR_INDEX_UNAVAILABLE'); }
  }
  private updateCorpusDigest(spaceKey: string): void {
    const rows = this.database.raw.prepare(`SELECT scope_key, kind, memory_id, revision, digest FROM memory_vector_rows
      WHERE space_key = ? ORDER BY scope_key, kind, memory_id`).all(spaceKey);
    this.database.raw.prepare('UPDATE vector_experiment_meta SET corpus_digest = ? WHERE space_key = ?')
      .run(createHash('sha256').update(canonicalJson(rows)).digest('hex'), spaceKey);
  }
}

// Keep the caller's readonly element types: Array.isArray otherwise narrows them to any[].
function assertBoundedArray(value: unknown, maximum: number): void {
  if (!Array.isArray(value) || value.length > maximum) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new VectorExperimentError('VECTOR_INPUT_INVALID');
  }
}
