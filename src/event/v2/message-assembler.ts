import type {
  AgentEventEnvelopeV2,
  AgentEventTypeV2,
  AgentMessageV2,
  ContentBlockCompletedPayloadV2,
  ContentBlockDeltaPayloadV2,
  ContentBlockStartedPayloadV2,
  MessageBlockV2,
  MessageStore,
} from '../../contracts/index.js';
import { parseMessageBlockV2 } from '../../contracts/message-v2/schema.js';

interface WorkingBlockV2 {
  blockId: string;
  type: ContentBlockStartedPayloadV2['blockType'];
  index: number;
  text: string;
  completed: boolean;
  block?: MessageBlockV2;
}

interface AssemblyStateV2 {
  message: AgentMessageV2;
  version: number;
  blocks: Map<string, WorkingBlockV2>;
  seenEventIds: Set<string>;
}

export class MessageAssemblyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MessageAssemblyError';
  }
}

export class MessageAssemblerV2 {
  private readonly states = new Map<string, AssemblyStateV2>();

  public constructor(private readonly store: MessageStore) {}

  public async apply(event: AgentEventEnvelopeV2): Promise<AgentMessageV2 | null> {
    if (!isMessageEvent(event)) return null;
    const messageId = event.payload.messageId;
    if (event.type === 'MESSAGE_STARTED') return this.start(event);
    const current = this.states.get(messageId);
    if (current === undefined) throw new MessageAssemblyError(`message ${messageId} has not started`);
    if (current.seenEventIds.has(event.eventId)) return structuredClone(current.message);
    if (current.message.status !== 'streaming') throw new MessageAssemblyError(`message ${messageId} is already terminal`);

    const next = structuredClone(current);
    switch (event.type) {
      case 'CONTENT_BLOCK_STARTED':
        this.startBlock(next, event.payload as ContentBlockStartedPayloadV2);
        break;
      case 'CONTENT_BLOCK_DELTA':
        this.appendDelta(next, event.payload as ContentBlockDeltaPayloadV2);
        break;
      case 'CONTENT_BLOCK_COMPLETED':
        this.completeBlock(next, event.payload as ContentBlockCompletedPayloadV2);
        break;
      case 'MESSAGE_COMPLETED':
        if ([...next.blocks.values()].some((block) => !block.completed)) {
          throw new MessageAssemblyError(`message ${messageId} has unfinished blocks`);
        }
        next.message.status = 'completed';
        next.message.completedAt = event.payload.completedAt;
        break;
      case 'MESSAGE_FAILED':
        next.message.status = 'failed';
        next.message.completedAt = event.timestamp;
        next.message.blocks = this.completedBlocks(next);
        next.message.blocks.push({ blockId: `${messageId}:error:${event.eventId}`, type: 'error', error: event.payload.error });
        break;
    }
    next.seenEventIds.add(event.eventId);
    return this.persist(messageId, next);
  }

  public async interrupt(messageId: string, completedAt: string): Promise<AgentMessageV2> {
    const current = this.states.get(messageId);
    if (current === undefined) throw new MessageAssemblyError(`message ${messageId} has not started`);
    if (current.message.status !== 'streaming') throw new MessageAssemblyError(`message ${messageId} is already terminal`);
    const next = structuredClone(current);
    next.message.status = 'interrupted';
    next.message.completedAt = completedAt;
    next.message.blocks = this.completedBlocks(next);
    return this.persist(messageId, next);
  }

  private async start(event: AgentEventEnvelopeV2<'MESSAGE_STARTED'>): Promise<AgentMessageV2> {
    const { messageId, role } = event.payload;
    const existing = this.states.get(messageId);
    if (existing?.seenEventIds.has(event.eventId) === true) return structuredClone(existing.message);
    if (existing !== undefined) throw new MessageAssemblyError(`message ${messageId} has already started`);
    const message: AgentMessageV2 = {
      schemaVersion: 2,
      id: messageId,
      runId: event.runId,
      role,
      status: 'streaming',
      visibility: event.visibility === 'public' ? 'user' : 'audit',
      blocks: [],
      createdAt: event.timestamp,
      ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      ...(event.replyId === undefined ? {} : { replyId: event.replyId }),
      ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    };
    const stored = await this.store.saveMessage(message, null);
    this.states.set(messageId, {
      message: stored.message,
      version: stored.version,
      blocks: new Map(),
      seenEventIds: new Set([event.eventId]),
    });
    return structuredClone(stored.message);
  }

  private startBlock(state: AssemblyStateV2, payload: ContentBlockStartedPayloadV2): void {
    if (state.blocks.has(payload.blockId)) throw new MessageAssemblyError(`block ${payload.blockId} has already started`);
    if (payload.index !== state.blocks.size) throw new MessageAssemblyError(`block index ${payload.index} is out of order`);
    state.blocks.set(payload.blockId, {
      blockId: payload.blockId,
      type: payload.blockType,
      index: payload.index,
      text: '',
      completed: false,
    });
  }

  private appendDelta(state: AssemblyStateV2, payload: ContentBlockDeltaPayloadV2): void {
    const block = this.requireBlock(state, payload.blockId, payload.index);
    if (block.completed) throw new MessageAssemblyError(`block ${payload.blockId} is already complete`);
    if (block.type !== 'text' && block.type !== 'reasoning_summary') {
      throw new MessageAssemblyError(`block type ${block.type} does not accept text deltas`);
    }
    block.text += payload.delta;
  }

  private completeBlock(state: AssemblyStateV2, payload: ContentBlockCompletedPayloadV2): void {
    const block = this.requireBlock(state, payload.blockId, payload.index);
    if (block.completed) throw new MessageAssemblyError(`block ${payload.blockId} is already complete`);
    if (block.type === 'text') {
      block.block = { blockId: block.blockId, type: 'text', text: block.text };
    } else if (block.type === 'reasoning_summary') {
      block.block = { blockId: block.blockId, type: 'reasoning_summary', summary: block.text };
    } else {
      if (payload.block === undefined) throw new MessageAssemblyError(`completed ${block.type} block requires a full block payload`);
      const parsed = parseMessageBlockV2(payload.block);
      if (parsed.blockId !== block.blockId || parsed.type !== block.type) {
        throw new MessageAssemblyError(`completed block does not match started block ${block.blockId}`);
      }
      block.block = parsed;
    }
    block.completed = true;
  }

  private requireBlock(state: AssemblyStateV2, blockId: string, index: number): WorkingBlockV2 {
    const block = state.blocks.get(blockId);
    if (block === undefined) throw new MessageAssemblyError(`block ${blockId} has not started`);
    if (block.index !== index) throw new MessageAssemblyError(`block ${blockId} index mismatch`);
    return block;
  }

  private async persist(messageId: string, state: AssemblyStateV2): Promise<AgentMessageV2> {
    if (state.message.status !== 'failed' && state.message.status !== 'interrupted') {
      state.message.blocks = this.snapshotBlocks(state);
    }
    const stored = await this.store.saveMessage(state.message, state.version);
    state.message = stored.message;
    state.version = stored.version;
    this.states.set(messageId, state);
    return structuredClone(stored.message);
  }

  private snapshotBlocks(state: AssemblyStateV2): MessageBlockV2[] {
    return [...state.blocks.values()]
      .sort((left, right) => left.index - right.index)
      .flatMap((block): MessageBlockV2[] => {
        if (block.block !== undefined) return [block.block];
        if (block.type === 'text') return [{ blockId: block.blockId, type: 'text', text: block.text }];
        if (block.type === 'reasoning_summary') return [{ blockId: block.blockId, type: 'reasoning_summary', summary: block.text }];
        return [];
      });
  }

  private completedBlocks(state: AssemblyStateV2): MessageBlockV2[] {
    return [...state.blocks.values()]
      .filter((block): block is WorkingBlockV2 & { block: MessageBlockV2 } => block.completed && block.block !== undefined)
      .sort((left, right) => left.index - right.index)
      .map((block) => block.block);
  }
}

type MessageEventTypeV2 = Extract<AgentEventTypeV2,
  | 'MESSAGE_STARTED' | 'CONTENT_BLOCK_STARTED' | 'CONTENT_BLOCK_DELTA'
  | 'CONTENT_BLOCK_COMPLETED' | 'MESSAGE_COMPLETED' | 'MESSAGE_FAILED'>;

const MESSAGE_EVENT_TYPES = new Set<MessageEventTypeV2>([
  'MESSAGE_STARTED', 'CONTENT_BLOCK_STARTED', 'CONTENT_BLOCK_DELTA',
  'CONTENT_BLOCK_COMPLETED', 'MESSAGE_COMPLETED', 'MESSAGE_FAILED',
]);

function isMessageEvent(event: AgentEventEnvelopeV2): event is AgentEventEnvelopeV2<MessageEventTypeV2> {
  return MESSAGE_EVENT_TYPES.has(event.type as MessageEventTypeV2);
}
