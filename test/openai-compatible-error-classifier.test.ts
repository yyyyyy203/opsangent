import { describe, expect, it } from 'vitest';
import { classifyOpenAICompatibleError } from '../src/model/openai-compatible/error-classifier.js';

function providerError(status: number, fields: Record<string, unknown> = {}): unknown {
  return Object.assign(new Error('provider body must not escape'), { status, ...fields });
}

describe('OpenAI-compatible error classifier', () => {
  it('classifies billing and quota exhaustion as terminal', () => {
    const billing = classifyOpenAICompatibleError(providerError(402, { code: 'payment_required' }));
    const quota = classifyOpenAICompatibleError(providerError(429, { code: 'insufficient_quota' }));

    expect(billing).toMatchObject({ retryable: false, disposition: 'terminal', fallbackAllowed: false, details: { category: 'auth', status: 402, disposition: 'terminal' } });
    expect(quota).toMatchObject({ retryable: false, disposition: 'terminal', fallbackAllowed: false, details: { category: 'rate_limit', status: 429, disposition: 'terminal' } });
  });

  it('classifies client auth errors and ordinary forbidden errors as fallback-only', () => {
    const unauthorized = classifyOpenAICompatibleError(providerError(401, { code: 'invalid_api_key' }));
    const badRequest = classifyOpenAICompatibleError(providerError(400, { code: 'invalid_request_error' }));
    const forbidden = classifyOpenAICompatibleError(providerError(403, { code: 'permission_denied' }));

    expect(unauthorized).toMatchObject({ retryable: false, disposition: 'fallback_only', fallbackAllowed: true, details: { category: 'auth' } });
    expect(badRequest).toMatchObject({ retryable: false, disposition: 'fallback_only', fallbackAllowed: true, details: { category: 'protocol' } });
    expect(forbidden).toMatchObject({ retryable: false, disposition: 'fallback_only', fallbackAllowed: true, details: { category: 'auth' } });
  });

  it('classifies transient statuses and configured transient forbidden errors as retryable', () => {
    const rateLimit = classifyOpenAICompatibleError(providerError(429));
    const server = classifyOpenAICompatibleError(providerError(503));
    const forbidden = classifyOpenAICompatibleError(providerError(403, { code: 'temporary_policy_failure' }), {
      transientForbiddenCodes: ['temporary_policy_failure'],
    });

    expect(rateLimit).toMatchObject({ retryable: true, disposition: 'retryable', details: { category: 'rate_limit' } });
    expect(server).toMatchObject({ retryable: true, disposition: 'retryable', details: { category: 'server' } });
    expect(forbidden).toMatchObject({ retryable: true, disposition: 'retryable', details: { category: 'auth' } });
  });

  it('classifies network and cancellation failures without leaking provider text', () => {
    const network = classifyOpenAICompatibleError(new TypeError('socket failed at https://internal.example/secret'));
    const abortError = Object.assign(new Error('caller cancelled'), { name: 'AbortError' });
    const aborted = classifyOpenAICompatibleError(abortError);
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const signalAborted = classifyOpenAICompatibleError(new Error('cancelled'), { signal: controller.signal });

    expect(network).toMatchObject({ retryable: true, disposition: 'retryable', details: { category: 'network' } });
    expect(aborted).toMatchObject({ retryable: false, disposition: 'aborted', fallbackAllowed: false, details: { category: 'aborted' } });
    expect(signalAborted).toMatchObject({ retryable: false, disposition: 'aborted', fallbackAllowed: false });
    expect(network.message).not.toContain('internal.example');
    expect(network.details).not.toHaveProperty('message');
  });

  it('keeps a safe retry-after value for the retry decorator', () => {
    const failure = classifyOpenAICompatibleError(providerError(429, { headers: { 'retry-after': '1.5' } }));
    expect(failure.details).toMatchObject({ retryAfterMs: 1500 });
  });
});
