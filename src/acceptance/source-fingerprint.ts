import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const SOURCE_DIRECTORIES = ['src', 'apps'] as const;
const BUILD_INPUT_FILES = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.build.json', '.node-version'] as const;
const MAX_FILES = 8_192;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

/** Hash only source/build inputs; report the digest, never the paths or file contents. */
export async function createSourceFingerprint(repositoryRoot: string): Promise<string> {
  if (!isAbsolute(repositoryRoot) || repositoryRoot.includes('\0')) throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
  let root: string;
  try { root = await realpath(repositoryRoot); } catch { throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE'); }
  const files = new Set<string>();
  for (const directory of SOURCE_DIRECTORIES) {
    const absolute = join(root, directory);
    try {
      const info = await lstat(absolute);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
      await collectFiles(root, absolute, files);
    } catch {
      throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
    }
  }
  for (const file of BUILD_INPUT_FILES) {
    try {
      const info = await lstat(join(root, file));
      if (info.isFile() && !info.isSymbolicLink()) files.add(file);
      else throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
    } catch (error) {
      if (isNotFound(error)) continue;
      throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
    }
  }
  if (files.size === 0 || files.size > MAX_FILES) throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
  const hash = createHash('sha256');
  let totalBytes = 0;
  for (const path of [...files].sort()) {
    const normalized = path.split(sep).join('/');
    const absolute = join(root, path);
    const fromRoot = relative(root, absolute);
    if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
      throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
    }
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error('invalid input');
      totalBytes += info.size;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('input tree too large');
      const bytes = await readFile(absolute);
      if (bytes.byteLength !== info.size) throw new Error('input changed while hashing');
      hash.update(normalized, 'utf8').update('\0').update(String(bytes.byteLength), 'utf8').update('\0').update(bytes).update('\0');
    } catch {
      throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
    }
  }
  return hash.digest('hex');
}

async function collectFiles(root: string, directory: string, files: Set<string>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const absolute = join(directory, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
    if (info.isDirectory()) await collectFiles(root, absolute, files);
    else if (info.isFile()) {
      const path = relative(root, absolute);
      if (path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
      files.add(path);
      if (files.size > MAX_FILES) throw new Error('ACCEPTANCE_FINGERPRINT_UNAVAILABLE');
    }
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
