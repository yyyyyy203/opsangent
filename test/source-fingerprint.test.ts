import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSourceFingerprint } from '../src/acceptance/source-fingerprint.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('acceptance source fingerprint', () => {
  it('changes with compiled source and lockfile inputs but ignores credentials and test artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-source-fingerprint-'));
    roots.push(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'apps'), { recursive: true });
    await writeFile(join(root, 'src', 'agent.ts'), 'export const revision = 1;');
    await writeFile(join(root, 'apps', 'server.mjs'), 'export const server = true;');
    await writeFile(join(root, 'package.json'), '{"name":"fixture"}');
    await writeFile(join(root, '.env'), 'API_KEY=must-not-be-read');
    await mkdir(join(root, 'test-results'), { recursive: true });
    await writeFile(join(root, 'test-results', 'report.json'), 'private runtime output');

    const first = await createSourceFingerprint(root);
    await writeFile(join(root, '.env'), 'API_KEY=changed-secret');
    await writeFile(join(root, 'test-results', 'report.json'), 'changed private runtime output');
    expect(await createSourceFingerprint(root)).toBe(first);
    await writeFile(join(root, 'src', 'agent.ts'), 'export const revision = 2;');
    expect(await createSourceFingerprint(root)).not.toBe(first);
  });

  it('returns only a lowercase SHA-256 digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentops-source-fingerprint-shape-'));
    roots.push(root);
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'apps'));
    await writeFile(join(root, 'src', 'entry.ts'), 'export {};');
    await writeFile(join(root, 'apps', 'entry.mjs'), 'export {};');
    expect(await createSourceFingerprint(root)).toMatch(/^[a-f\d]{64}$/u);
  });
});
