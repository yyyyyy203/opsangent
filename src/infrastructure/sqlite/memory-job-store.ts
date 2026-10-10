import type { AgentContext } from '../../contracts/context.js';
import type { MemoryCaptureIntent } from '../../contracts/diagnostic-memory.js';
import type { GovernanceEffect } from '../../contracts/hooks.js';
import { stageAutomaticMemoryCapture, stageMemorySignals } from '../../memory/diagnostic-memory-state.js';
import type { SqliteDatabase } from './database.js';
import { createSqliteDiagnosticMemoryRepository } from './diagnostic-memory-store.js';

/** Called only inside the existing checkpoint transition transaction. */
export function persistMemorySignals(
  database: SqliteDatabase,
  context: AgentContext,
  effects: readonly GovernanceEffect[],
): void {
  stageMemorySignals(createSqliteDiagnosticMemoryRepository(database), context, effects);
}

/** Called only after the completed parent checkpoint has been staged in the caller's transaction. */
export function enqueueMemoryCapture(
  database: SqliteDatabase,
  intent: MemoryCaptureIntent,
): void {
  stageAutomaticMemoryCapture(createSqliteDiagnosticMemoryRepository(database), intent);
}
