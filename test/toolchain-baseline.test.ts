import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('pins the supported runtime and package manager', () => {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(pkg).toMatchObject({
    engines: { node: '>=24.0.0 <25.0.0' },
    packageManager: 'pnpm@11.19.0',
  });
  expect(readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim()).toBe('24');
});
