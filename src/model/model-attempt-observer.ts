import type { ModelResponse } from '../contracts/model.js';
import type { ModelFailureCategory } from './model-failure.js';

export type ModelAttemptEvent =
  | { type: 'started'; runId: string; stepId: string; sessionId?: string; replyId?: string; streamId?: string; attempt: number }
  | {
    type: 'retry_scheduled';
    runId: string;
    stepId: string;
    sessionId?: string;
    replyId?: string;
    streamId?: string;
    attempt: number;
    category: ModelFailureCategory;
    delayMs: number;
  }
  | {
    type: 'succeeded';
    runId: string;
    stepId: string;
    sessionId?: string;
    replyId?: string;
    streamId?: string;
    attempt: number;
    usage?: ModelResponse['usage'];
  }
  | {
    type: 'failed';
    runId: string;
    stepId: string;
    sessionId?: string;
    replyId?: string;
    streamId?: string;
    attempt: number;
    category: ModelFailureCategory;
    retryable: boolean;
  };

export interface ModelAttemptObserver {
  record(event: ModelAttemptEvent): void | Promise<void>;
}

export const NOOP_MODEL_ATTEMPT_OBSERVER: ModelAttemptObserver = {
  record: () => undefined,
};

export class CompositeModelAttemptObserver implements ModelAttemptObserver {
  public constructor(private readonly observers: readonly ModelAttemptObserver[]) {}

  public async record(event: ModelAttemptEvent): Promise<void> {
    await Promise.allSettled(this.observers.map((observer) => Promise.resolve(observer.record(event))));
  }
}
