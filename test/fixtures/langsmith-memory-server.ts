/** Offline fake at the HTTP boundary: stores only actual SDK-exported records. */
export function createLangSmithMemoryServer(options: { uploadStatus?: number; omitChild?: boolean; wrongUsage?: boolean } = {}) {
  const stored = new Map<string, Record<string, unknown>>();
  const queries: Record<string, unknown>[] = [];
  const routes: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== 'https://smith.invalid') throw new Error('EXTERNAL_NETWORK_BLOCKED');
    routes.push(url.pathname);
    if (url.pathname === '/info') return Response.json({ version: '0.1', batch_ingest_config: { use_multipart_endpoint: true } });
    if (url.pathname === '/runs/query') {
      const query = await request.json() as Record<string, unknown>;
      queries.push(query);
      const ids = query['id'] as string[];
      const select = query['select'] as string[];
      const runs = ids.flatMap((id) => {
        const storedRun = stored.get(id);
        if (storedRun === undefined || (options.omitChild === true && storedRun['run_type'] === 'llm')) return [];
        const run = Object.fromEntries(select.filter((key) => Object.hasOwn(storedRun, key)).map((key) => [key, storedRun[key]]));
        if (options.wrongUsage === true && storedRun['run_type'] === 'llm') {
          run['outputs'] = { status: 'completed', usage_metadata: { input_tokens: 12, output_tokens: 6, total_tokens: 18,
            input_token_details: { cache_read: 4 } } };
        }
        return [run];
      });
      return Response.json({ runs, cursors: { next: null } });
    }
    if (url.pathname !== '/runs/batch' && url.pathname !== '/runs/multipart') throw new Error('UNEXPECTED_TRACE_ROUTE');
    if (options.uploadStatus !== undefined) return new Response('PRIVATE_REMOTE_ERROR', { status: options.uploadStatus });
    if (url.pathname === '/runs/batch') {
      const body = await request.json() as Record<string, Record<string, unknown>[]>;
      for (const runs of Object.values(body)) for (const run of runs) merge(run);
    } else {
      const parts = new Map<string, Record<string, unknown>>();
      const data = await request.formData();
      data.forEach((value, name) => {
        if (typeof value !== 'string') throw new Error('UNEXPECTED_BINARY_UPLOAD');
        const match = /^(post|patch)\.([a-f0-9-]+)(?:\.(\w+))?$/u.exec(name);
        if (match?.[2] === undefined) throw new Error('UNEXPECTED_PART');
        const key = `${match[1]}.${match[2]}`;
        const run = parts.get(key) ?? { id: match[2] };
        const parsed: unknown = JSON.parse(value);
        if (match[3] === undefined) Object.assign(run, parsed);
        else run[match[3]] = parsed;
        parts.set(key, run);
      });
      for (const run of parts.values()) merge(run);
    }
    return Response.json({});
  };
  function merge(run: Record<string, unknown>): void {
    const id = run['id'];
    if (typeof id !== 'string') throw new Error('MISSING_REMOTE_ID');
    stored.set(id, { ...stored.get(id), ...run });
  }
  return { fetch, stored, queries, routes };
}
