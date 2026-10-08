const MAX_BUFFER_CHARS = 65_536;
const MAX_OBSERVED_BYTES = 1_048_576;
const TERMINAL_REASONS = new Set(['stop', 'tool_calls', 'function_call', 'length', 'content_filter']);
const SAFE_ERROR = 'Smoke model response was interrupted.';

/** A pull-through observer: bounded frame state, no tee, no eager response consumption. */
export function observeSmokeUsage(
  response: Response,
  model: unknown,
  maxOutputTokens: number,
  signal: AbortSignal | undefined,
  onUsage: (outputTokens: number) => void,
): Response {
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (!response.ok || response.body === null || (mediaType !== 'text/event-stream' && mediaType !== 'application/json')) return response;
  const observer = new UsageObserver(mediaType === 'text/event-stream', model, maxOutputTokens);
  const reader = response.body.getReader();
  let active = true;
  let target: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = (): void => {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  };
  const cancelSource = (reason?: unknown): void => {
    void reader.cancel(reason).catch(() => undefined);
    cleanup();
  };
  const abort = (): void => {
    if (!active) return;
    active = false;
    observer.invalidate();
    const reason: unknown = signal?.reason;
    target.error(new DOMException(SAFE_ERROR, reason instanceof Error && reason.name === 'TimeoutError' ? 'TimeoutError' : 'AbortError'));
    cancelSource();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      target = controller;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    },
    async pull(controller) {
      if (!active) return;
      try {
        const item = await reader.read();
        if (!active) return;
        if (item.done) {
          active = false;
          cleanup();
          const outputTokens = observer.finish();
          if (!signal?.aborted && outputTokens !== undefined) onUsage(outputTokens);
          controller.close();
        } else {
          observer.push(item.value);
          controller.enqueue(item.value);
        }
      } catch (error) {
        if (!active) return;
        active = false;
        observer.invalidate();
        cleanup();
        controller.error(error instanceof TypeError ? new TypeError(SAFE_ERROR) : new Error(SAFE_ERROR));
      }
    },
    cancel(reason: unknown) {
      if (!active) return;
      active = false;
      observer.invalidate();
      cancelSource(reason);
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

class UsageObserver {
  private valid = true;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private bytes = 0;
  private line = '';
  private data = '';
  private json = '';
  private eventType = '';
  private frameChars = 0;
  private afterCR = false;
  private hasData = false;
  private responseId: string | undefined;
  private terminal = false;
  private done = false;
  private outputTokens: number | undefined;

  public constructor(
    private readonly sse: boolean,
    private readonly model: unknown,
    private readonly cap: number,
  ) {}

  public invalidate(): void {
    this.valid = false;
    this.line = '';
    this.data = '';
    this.json = '';
    this.outputTokens = undefined;
  }

  public push(bytes: Uint8Array): void {
    if (!this.valid) return;
    this.bytes += bytes.byteLength;
    if (this.bytes > MAX_OBSERVED_BYTES) { this.invalidate(); return; }
    try {
      // Even a huge upstream chunk cannot create an unbounded decoded string.
      for (let offset = 0; offset < bytes.byteLength && this.valid; offset += 4096) {
        this.consume(this.decoder.decode(bytes.subarray(offset, offset + 4096), { stream: true }));
      }
    } catch {
      this.invalidate();
    }
  }

  public finish(): number | undefined {
    if (!this.valid) return undefined;
    try {
      this.consume(this.decoder.decode());
      if (!this.valid) return undefined;
      if (!this.sse) {
        const value: unknown = JSON.parse(this.json) as unknown;
        if (!this.matches(value, 'chat.completion') || !Array.isArray(value['choices']) || value['choices'].length !== 1) return undefined;
        const choice: unknown = value['choices'][0];
        if (!isRecord(choice) || choice['index'] !== 0 || !isRecord(choice['message'])
          || typeof choice['finish_reason'] !== 'string' || !TERMINAL_REASONS.has(choice['finish_reason'])) return undefined;
        return readUsage(value['usage'], this.cap);
      }
      return this.line === '' && !this.hasData && this.done && this.terminal ? this.outputTokens : undefined;
    } catch {
      return undefined;
    } finally {
      this.line = '';
      this.data = '';
      this.json = '';
    }
  }

  private consume(text: string): void {
    if (!this.sse) {
      if (this.json.length + text.length > MAX_BUFFER_CHARS) this.invalidate();
      else this.json += text;
      return;
    }
    for (const character of text) {
      if (!this.valid) return;
      if (this.afterCR) {
        this.afterCR = false;
        if (character === '\n') continue;
      }
      if (character === '\r' || character === '\n') {
        const line = this.line;
        this.line = '';
        this.acceptLine(line);
        this.afterCR = character === '\r';
      } else if (this.line.length + character.length > MAX_BUFFER_CHARS) {
        this.invalidate();
      } else {
        this.line += character;
      }
    }
  }

  private acceptLine(line: string): void {
    this.frameChars += line.length + 1;
    if (this.frameChars > MAX_BUFFER_CHARS) { this.invalidate(); return; }
    if (line === '') {
      if (this.hasData) this.acceptEvent();
      this.data = '';
      this.hasData = false;
      this.eventType = '';
      this.frameChars = 0;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
    if (field === 'event') this.eventType = value;
    if (field === 'data') {
      this.data += `${this.hasData ? '\n' : ''}${value}`;
      this.hasData = true;
    }
  }

  private acceptEvent(): void {
    if (this.eventType !== '' && this.eventType !== 'message') { this.invalidate(); return; }
    if (this.data.trim() === '[DONE]') {
      if (this.done || !this.terminal || this.outputTokens === undefined) this.invalidate();
      else this.done = true;
      return;
    }
    if (this.done || this.outputTokens !== undefined) { this.invalidate(); return; }
    const value: unknown = JSON.parse(this.data) as unknown;
    if (!this.matches(value, 'chat.completion.chunk') || !Array.isArray(value['choices']) || value['choices'].length > 1) {
      this.invalidate(); return;
    }
    const choice: unknown = value['choices'][0];
    if (choice !== undefined) {
      if (!isRecord(choice) || choice['index'] !== 0 || this.terminal
        || (choice['delta'] !== undefined && !isRecord(choice['delta']))) { this.invalidate(); return; }
      const reason = choice['finish_reason'];
      if (reason !== undefined && reason !== null) {
        if (typeof reason !== 'string' || !TERMINAL_REASONS.has(reason)) { this.invalidate(); return; }
        this.terminal = true;
      }
    }
    if (value['usage'] !== undefined && value['usage'] !== null) {
      const outputTokens = readUsage(value['usage'], this.cap);
      if (!this.terminal || outputTokens === undefined) this.invalidate();
      else this.outputTokens = outputTokens;
    }
  }

  private matches(value: unknown, object: string): value is Record<string, unknown> {
    if (!isRecord(value) || value['error'] !== undefined || value['object'] !== object
      || typeof this.model !== 'string' || this.model.length === 0 || value['model'] !== this.model
      || typeof value['id'] !== 'string' || value['id'].length === 0 || value['id'].length > 256) return false;
    if (this.responseId !== undefined && value['id'] !== this.responseId) return false;
    this.responseId = value['id'];
    return true;
  }
}

function readUsage(value: unknown, cap: number): number | undefined {
  if (!isRecord(value)) return undefined;
  const input = value['prompt_tokens'];
  const output = value['completion_tokens'];
  const total = value['total_tokens'];
  if (!isCount(input) || !isCount(output) || !isCount(total) || output > cap
    || !Number.isSafeInteger(input + output) || total !== input + output) return undefined;
  for (const [field, maximum] of [['prompt_tokens_details', input], ['completion_tokens_details', output]] as const) {
    const details = value[field];
    if (details === undefined || details === null) continue;
    if (!isRecord(details) || Object.values(details).some((counter) => !isCount(counter) || counter > maximum)) return undefined;
  }
  return output;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
