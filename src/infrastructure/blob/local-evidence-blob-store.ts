import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from '../../contracts/common.js';
import type {
  BeginEvidenceBlobInput,
  EvidenceBlobDescriptor,
  EvidenceBlobStore,
  EvidenceBlobWriter,
  EvidenceChunkRef,
} from '../../contracts/storage.js';

const gzipAsync = promisify(gzip);

export interface LocalEvidenceBlobStoreOptions {
  rootPath: string;
  ids?: IdGenerator;
  clock?: Clock;
  readChunkBytes?: number;
}

export class LocalEvidenceBlobStore implements EvidenceBlobStore {
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly readChunkBytes: number;

  public constructor(private readonly options: LocalEvidenceBlobStoreOptions) {
    if (!isAbsolute(options.rootPath)) throw new RangeError('Blob rootPath must be absolute');
    this.ids = options.ids ?? randomIdGenerator;
    this.clock = options.clock ?? systemClock;
    this.readChunkBytes = options.readChunkBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(this.readChunkBytes) || this.readChunkBytes <= 0) {
      throw new RangeError('readChunkBytes must be a positive safe integer');
    }
  }

  public async begin(input: BeginEvidenceBlobInput): Promise<EvidenceBlobWriter> {
    validateBeginInput(input);
    await mkdir(this.options.rootPath, { recursive: true });
    const storageKey = input.manifestId + '/chunk-' + input.chunkIndex + '-' + this.ids.next('blob') + '.gz';
    const finalPath = this.pathForKey(storageKey);
    return new LocalEvidenceBlobWriter({
      input,
      storageKey,
      finalPath,
      temporaryPath: finalPath + '.tmp-' + this.ids.next('tmp'),
      clock: this.clock,
    });
  }

  public async *readChunk(ref: EvidenceChunkRef): AsyncIterable<Uint8Array> {
    const stream = createReadStream(this.pathForKey(ref.storageKey), {
      highWaterMark: this.readChunkBytes,
    });
    for await (const chunk of stream) yield new Uint8Array(chunk as Buffer);
  }

  public async delete(ref: EvidenceBlobDescriptor): Promise<void> {
    for (const chunk of ref.chunks) await rm(this.pathForKey(chunk.storageKey), { force: true });
  }

  private pathForKey(storageKey: string): string {
    const normalized = storageKey.replaceAll('\\', '/');
    const segments = normalized.split('/');
    if (normalized.length === 0 || normalized.startsWith('/') || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
      throw new Error('Invalid Blob storage key');
    }
    const candidate = resolve(this.options.rootPath, ...segments);
    const root = resolve(this.options.rootPath);
    const relativePath = relative(root, candidate);
    if (relativePath === '..' || relativePath.startsWith('..' + '\\') || relativePath.startsWith('../') || relativePath.includes(':')) {
      throw new Error('Blob storage key escapes the configured root');
    }
    return candidate;
  }
}

interface LocalEvidenceBlobWriterOptions {
  input: BeginEvidenceBlobInput;
  storageKey: string;
  finalPath: string;
  temporaryPath: string;
  clock: Clock;
}

class LocalEvidenceBlobWriter implements EvidenceBlobWriter {
  private readonly pieces: Buffer[] = [];
  private sourceBytes = 0;
  private state: 'open' | 'committed' | 'aborted' = 'open';
  private descriptor?: EvidenceBlobDescriptor;

  public constructor(private readonly options: LocalEvidenceBlobWriterOptions) {}

  public write(chunk: Uint8Array, options?: { signal?: AbortSignal }): Promise<void> {
    return Promise.resolve().then(() => {
      this.assertOpen();
      if (options?.signal?.aborted === true) throw new Error('Blob write aborted');
      const piece = Buffer.from(chunk);
      if (piece.length === 0) return;
      if (this.sourceBytes + piece.length > this.options.input.chunkTargetBytes) {
        throw new RangeError('Blob chunk exceeds the configured target size');
      }
      this.pieces.push(piece);
      this.sourceBytes += piece.length;
    });
  }

  public async commit(): Promise<EvidenceBlobDescriptor> {
    if (this.state === 'committed' && this.descriptor !== undefined) return structuredClone(this.descriptor);
    this.assertOpen();
    const source = Buffer.concat(this.pieces);
    const sourceHash = createHash('sha256').update(source).digest('hex');
    const compressed = await gzipAsync(source);
    try {
      await mkdir(dirname(this.options.finalPath), { recursive: true });
      await writeFile(this.options.temporaryPath, compressed, { flag: 'wx' });
      await rename(this.options.temporaryPath, this.options.finalPath);
      const chunk: EvidenceChunkRef = {
        manifestId: this.options.input.manifestId,
        evidenceId: this.options.input.evidenceId,
        chunkIndex: this.options.input.chunkIndex,
        storageKey: this.options.storageKey,
        recordCount: this.options.input.recordCount ?? 0,
        sourceBytes: source.length,
        storedBytes: compressed.length,
        sha256: sourceHash,
        ...(this.options.input.firstCapturedAt === undefined ? {} : { firstCapturedAt: this.options.input.firstCapturedAt }),
        ...(this.options.input.lastCapturedAt === undefined ? {} : { lastCapturedAt: this.options.input.lastCapturedAt }),
        committedAt: this.options.clock.now().toISOString(),
      };
      this.descriptor = {
        manifestId: this.options.input.manifestId,
        evidenceId: this.options.input.evidenceId,
        captureKey: this.options.input.captureKey,
        compression: 'gzip_ndjson',
        sourceBytes: source.length,
        storedBytes: compressed.length,
        rawSha256: sourceHash,
        chunks: [chunk],
      };
      this.state = 'committed';
      this.pieces.length = 0;
      return structuredClone(this.descriptor);
    } catch (error) {
      await rm(this.options.temporaryPath, { force: true });
      throw error;
    }
  }

  public async abort(reasonCode: string): Promise<void> {
    if (reasonCode.length === 0) throw new Error('Blob abort requires a reason code');
    if (this.state === 'committed') throw new Error('Committed Blob cannot be aborted');
    if (this.state === 'aborted') return;
    this.pieces.length = 0;
    this.state = 'aborted';
    await rm(this.options.temporaryPath, { force: true });
  }

  private assertOpen(): void {
    if (this.state === 'aborted') throw new Error('Blob writer has been aborted');
    if (this.state === 'committed') throw new Error('Blob writer has already been committed');
  }
}

function validateBeginInput(input: BeginEvidenceBlobInput): void {
  if (!safeSegment(input.manifestId) || !safeSegment(input.evidenceId) || input.captureKey.length === 0) {
    throw new Error('Blob identity contains an invalid path identity');
  }
  if (!Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0) throw new RangeError('chunkIndex must be a non-negative safe integer');
  if (!Number.isSafeInteger(input.chunkTargetBytes) || input.chunkTargetBytes <= 0) throw new RangeError('chunkTargetBytes must be positive');
}

function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value);
}
