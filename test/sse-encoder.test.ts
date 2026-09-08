import { describe, expect, it } from 'vitest';
import { encodeSseFrame } from '../src/api/sse-encoder.js';

describe('SSE wire encoding', () => {
  it('round trips JSON newlines without injecting SSE fields', () => {
    const data = { text: 'hello\n\nid: forged\r\nworld', sequence: 7 };
    const encoded = encodeSseFrame({ id: 'event-7', event: 'CONTENT_BLOCK_DELTA', data });
    expect(encoded.split('\n').filter((line) => line.startsWith('id:'))).toEqual(['id: event-7']);
    expect(JSON.parse(encoded.split('\n').find((line) => line.startsWith('data: '))!.slice(6))).toEqual(data);
    expect(encoded.endsWith('\n\n')).toBe(true);
  });
  it.each(['bad\nid: forged', 'bad\rfield', 'bad\0field'])('rejects unsafe identifiers %j', (value) => {
    expect(() => encodeSseFrame({ id: value, event: 'message', data: {} })).toThrow();
    expect(() => encodeSseFrame({ id: 'event-1', event: value, data: {} })).toThrow();
  });
  it('rejects non JSON-safe content', () => {
    expect(() => encodeSseFrame({ event: 'message', data: { value: Infinity } })).toThrow();
  });
});
