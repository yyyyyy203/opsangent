import type { Clock } from '../contracts/common.js';
import type { InMemoryDiagnosticTransaction, InMemoryDiagnosticRecords } from './diagnostic-memory-state.js';
import { cloneInMemoryDiagnosticRecords, createInMemoryDiagnosticRecords,
  createInMemoryDiagnosticRepository, DiagnosticMemoryStoreCore } from './diagnostic-memory-state.js';

/** Test/runtime adapter with copy-on-write transactions matching the SQLite store. */
export class InMemoryDiagnosticMemoryStore extends DiagnosticMemoryStoreCore {
  private transaction: InMemoryDiagnosticTransaction;

  public constructor(input: { clock: Clock; transaction?: InMemoryDiagnosticTransaction }) {
    super(input.clock);
    this.transaction = input.transaction ?? {
      checkpointRecords: new Map(), executionRecords: new Map(), outboxRecords: new Map(),
      memory: createInMemoryDiagnosticRecords(),
    };
  }

  protected read<T>(operation: (repo: ReturnType<typeof createInMemoryDiagnosticRepository>) => T): Promise<T> {
    return Promise.resolve().then(() => operation(createInMemoryDiagnosticRepository(this.transaction)));
  }

  protected transact<T>(operation: (repo: ReturnType<typeof createInMemoryDiagnosticRepository>) => T): Promise<T> {
    return Promise.resolve().then(() => {
      const target = this.transaction;
      const working: InMemoryDiagnosticTransaction = {
        checkpointRecords: cloneMap(target.checkpointRecords),
        executionRecords: cloneMap(target.executionRecords),
        outboxRecords: cloneMap(target.outboxRecords),
        memory: cloneInMemoryDiagnosticRecords(target.memory),
      };
      const result = operation(createInMemoryDiagnosticRepository(working));
      if (target === this.transaction) {
        replaceMap(target.checkpointRecords, working.checkpointRecords);
        replaceMap(target.executionRecords, working.executionRecords);
        replaceMap(target.outboxRecords, working.outboxRecords);
        replaceMemory(target.memory, working.memory);
      }
      return structuredClone(result);
    });
  }
}

function cloneMap<K, V>(source: Map<K, V>): Map<K, V> {
  return new Map([...source].map(([key, value]) => [key, structuredClone(value)]));
}

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [key, value] of source) target.set(key, structuredClone(value));
}

function replaceMemory(target: InMemoryDiagnosticRecords, source: InMemoryDiagnosticRecords): void {
  replaceMap(target.cases, source.cases);
  replaceMap(target.indexes, source.indexes);
  replaceMap(target.jobs, source.jobs);
  replaceMap(target.captureCommands, source.captureCommands);
  replaceMap(target.reviews, source.reviews);
  replaceMap(target.signals, source.signals);
}
