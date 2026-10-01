import type { AgentContext } from '../contracts/context.js';
import type { StoredRunCheckpoint } from '../contracts/storage.js';
import type { PublicConfirmation, PublicProfile } from '../contracts/web-read-model.js';
import { PublicMessageProjectorV2 } from '../event/projectors/public-message-projector.js';

interface CheckpointReader { load(runId: string): Promise<Pick<StoredRunCheckpoint, 'revision'> & { context: Pick<AgentContext, 'status' | 'pendingInterrupt'> } | null> }
export interface ConfiguredWebProfile { id: string; name: string; description: string; enabled: boolean; capabilities: { readOnly: boolean } }
export class WebQueryService {
  private readonly projector = new PublicMessageProjectorV2();
  public constructor(private readonly checkpoints: CheckpointReader, private readonly profiles: readonly ConfiguredWebProfile[], private readonly now: () => Date) {}

  public listProfiles(): readonly PublicProfile[] {
    return this.profiles.filter((profile) => profile.enabled).map((profile) => ({
      id: this.safe(profile.id), name: this.safe(profile.name), description: this.safe(profile.description),
      capabilities: { readOnly: profile.capabilities.readOnly },
    }));
  }

  public async getConfirmation(runId: string): Promise<PublicConfirmation | null> {
    const checkpoint = await this.checkpoints.load(runId);
    if (checkpoint === null) throw Object.assign(new Error('Run not found.'), { code: 'RUN_NOT_FOUND', statusCode: 404 });
    const interrupt = checkpoint.context.pendingInterrupt;
    if (checkpoint.context.status !== 'awaiting_confirmation' || interrupt === undefined) return null;
    if (interrupt.expiresAt !== undefined && Date.parse(interrupt.expiresAt) <= this.now().getTime()) return null;
    const raw = interrupt.payload.summary ?? interrupt.payload.riskSummary;
    return { runId, toolCallId: interrupt.toolCallId, expectedRevision: checkpoint.revision,
      summary: this.safe(typeof raw === 'string' ? raw : 'Confirmation required.'),
      ...(interrupt.expiresAt === undefined ? {} : { expiresAt: interrupt.expiresAt }) };
  }

  private safe(text: string): string {
    const projected = this.projector.project({ schemaVersion: 2, id: 'safe-field', runId: 'safe-field', role: 'assistant', status: 'completed', visibility: 'user', createdAt: '2026-10-01T00:00:00.000Z', blocks: [{ type: 'text', blockId: 'safe-field', text }] });
    const block = projected?.blocks[0];
    return block?.type === 'text' ? block.text : '[REDACTED]';
  }
}
