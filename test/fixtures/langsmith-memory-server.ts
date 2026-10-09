/** Offline fake at the HTTP boundary: stores only actual SDK-exported records. */
export type LangSmithMemoryReadbackMismatch = 'input_shape' | 'unsafe_shape' | 'extra_shape'
  | 'metadata_shape' | 'error_shape' | 'trace_id' | 'parent_run_id' | 'end_time' | 'run_error' | 'name'
  | 'run_type' | 'output_status' | 'run_status' | 'usage_metadata' | 'input_tokens' | 'output_tokens'
  | 'total_tokens' | 'cache_read';

export function createLangSmithMemoryServer(options: {
  uploadStatus?: number;
  omitChild?: boolean;
  wrongUsage?: boolean;
  readbackMismatch?: LangSmithMemoryReadbackMismatch;
  readbackMismatchSpan?: 'root' | 'model';
  unselectedTopLevelFieldCount?: number;
  langSmithRunDepth?: number;
} = {}) {
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
        if (options.langSmithRunDepth !== undefined) {
          const extra = isRecord(run['extra']) ? { ...run['extra'] } : {};
          const metadata = isRecord(extra['metadata']) ? { ...extra['metadata'] } : {};
          metadata['ls_run_depth'] = options.langSmithRunDepth;
          extra['metadata'] = metadata;
          run['extra'] = extra;
        }
        const isModelSpan = storedRun['run_type'] === 'llm';
        const isSelectedMismatchSpan = options.readbackMismatchSpan === 'root'
          ? storedRun['run_type'] === 'chain'
          : isModelSpan;
        if (isModelSpan || isSelectedMismatchSpan) {
          const outputs = isRecord(run['outputs']) ? { ...run['outputs'] } : {};
          const usage = isRecord(outputs['usage_metadata']) ? { ...outputs['usage_metadata'] } : {};
          let includeUsage = true;
          if (isSelectedMismatchSpan) switch (options.readbackMismatch) {
            case 'input_shape': {
              const inputs = isRecord(run['inputs']) ? { ...run['inputs'] } : {};
              inputs['privateInput'] = 'REMOTE_READBACK_CANARY';
              run['inputs'] = inputs;
              break;
            }
            case 'unsafe_shape': outputs['privateText'] = 'REMOTE_READBACK_CANARY'; break;
            case 'extra_shape': {
              const extra = isRecord(run['extra']) ? { ...run['extra'] } : {};
              extra['privateExtra'] = 'REMOTE_READBACK_CANARY';
              run['extra'] = extra;
              break;
            }
            case 'metadata_shape': {
              const extra = isRecord(run['extra']) ? { ...run['extra'] } : {};
              const metadata = isRecord(extra['metadata']) ? { ...extra['metadata'] } : {};
              metadata['privateMetadata'] = 'REMOTE_READBACK_CANARY';
              extra['metadata'] = metadata;
              run['extra'] = extra;
              break;
            }
            case 'error_shape': run['error'] = 'REMOTE_READBACK_CANARY'; break;
            case 'trace_id': run['trace_id'] = 'foreign-trace'; break;
            case 'parent_run_id': run['parent_run_id'] = 'foreign-parent'; break;
            case 'end_time': run['end_time'] = 'invalid-time'; break;
            case 'run_error': run['error'] = 'TRACE_ERROR'; break;
            case 'name': run['name'] = 'foreign.run'; break;
            case 'run_type': run['run_type'] = 'chain'; break;
            case 'output_status': outputs['status'] = 'running'; break;
            case 'run_status': run['status'] = 'error'; break;
            case 'usage_metadata': delete outputs['usage_metadata']; includeUsage = false; break;
            case 'input_tokens': usage['input_tokens'] = 13; break;
            case 'output_tokens': usage['output_tokens'] = 6; break;
            case 'total_tokens': usage['total_tokens'] = 18; break;
            case 'cache_read': usage['input_token_details'] = { cache_read: 3 }; break;
            default:
              if (isModelSpan && options.wrongUsage === true) {
                usage['input_tokens'] = 12;
                usage['output_tokens'] = 6;
                usage['total_tokens'] = 18;
                usage['input_token_details'] = { cache_read: 4 };
              }
          }
          if (includeUsage && Object.keys(usage).length > 0) outputs['usage_metadata'] = usage;
          run['outputs'] = outputs;
        }
        for (let index = 0; index < (options.unselectedTopLevelFieldCount ?? 0); index += 1) {
          run[`remoteOnlyField${index}`] = 'REMOTE_READBACK_CANARY';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
