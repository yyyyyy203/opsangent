import type {
  AgentEventEnvelopeV2,
  AgentEventTypeV2,
  AgentMessageV2,
  ContentBlockCompletedPayloadV2,
  ContentBlockDeltaPayloadV2,
  ContentBlockStartedPayloadV2,
  JsonObject,
  JsonValue,
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
  lastSequence: number;
}

interface PersistedAssemblyBlockV2 {
  blockId: string;
  type: WorkingBlockV2['type'];
  index: number;
  text: string;
  completed: boolean;
  block?: MessageBlockV2;
}

interface PersistedAssemblyStateV2 {
  version: 1;
  lastSequence: number;
  blocks: PersistedAssemblyBlockV2[];
}

const ASSEMBLY_METADATA_KEY = '__newton_message_assembly_v1';

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
    const current = await this.getOrRestore(messageId);
    if (current === undefined) throw new MessageAssemblyError(`message ${messageId} has not started`);
    if (current.seenEventIds.has(event.eventId)) return structuredClone(current.message);
    if (event.sequence <= current.lastSequence) return structuredClone(current.message);
    if (current.message.status !== 'streaming') {
      // A persisted terminal snapshot may be rebuilt by replaying its historical events.
      // Only events newer than the terminal timestamp are considered an invalid mutation.
      if (current.message.completedAt !== undefined && event.timestamp <= current.message.completedAt) return structuredClone(current.message);
      throw new MessageAssemblyError(`message ${messageId} is already terminal`);
    }

    const next = structuredClone(current);
    switch (event.type) {
      case 'CONTENT_BLOCK_STARTED':
        this.startBlock(next, event.payload);
        break;
      case 'CONTENT_BLOCK_DELTA':
        this.appendDelta(next, event.payload);
        break;
      case 'CONTENT_BLOCK_COMPLETED':
        this.completeBlock(next, event.payload);
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
    next.lastSequence = event.sequence;
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
    const existingStored = await this.store.getMessage(messageId);
    if (existingStored !== null) {
      if (existingStored.message.runId !== event.runId) throw new MessageAssemblyError(`message ${messageId} belongs to another run`);
      this.restoreStored(existingStored.message, existingStored.version);
      return structuredClone(existingStored.message);
    }
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
    const saved = await this.store.saveMessage(message, null);
    this.states.set(messageId, {
      message: saved.message,
      version: saved.version,
      blocks: new Map(),
      seenEventIds: new Set([event.eventId]),
      lastSequence: event.sequence,
    });
    return structuredClone(saved.message);
  }

  private async getOrRestore(messageId: string): Promise<AssemblyStateV2> {
    const current = this.states.get(messageId);
    if (current !== undefined) return current;
    const stored = await this.store.getMessage(messageId);
    if (stored === null) throw new MessageAssemblyError(`message ${messageId} has not started`);
    return this.restoreStored(stored.message, stored.version);
  }

  private restoreStored(message: AgentMessageV2, version: number): AssemblyStateV2 {
    const persisted = readAssemblyMetadata(message.metadata?.[ASSEMBLY_METADATA_KEY], message.id);
    const blocks = persisted?.blocks ?? message.blocks.map((block, index) => ({
      blockId: block.blockId,
      type: block.type,
      index,
      text: block.type === 'text' ? block.text : block.type === 'reasoning_summary' ? block.summary : '',
      completed: true,
      block: structuredClone(block),
    }));
    const restored: AssemblyStateV2 = {
      message: structuredClone(message),
      version,
      blocks: new Map(blocks.map((block) => [block.blockId, structuredClone(block)])),
      seenEventIds: new Set(),
      lastSequence: persisted?.lastSequence ?? 0,
    };
    this.states.set(message.id, restored);
    return restored;
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
    if (state.message.status === 'streaming') {
      state.message.blocks = this.snapshotBlocks(state);
      state.message = withAssemblyMetadata(state.message, state);
    } else {
      state.message = withoutAssemblyMetadata(state.message);
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

function withAssemblyMetadata(message: AgentMessageV2, state: AssemblyStateV2): AgentMessageV2 {
  const persisted: JsonObject = {
    version: 1,
    lastSequence: state.lastSequence,
    blocks: [...state.blocks.values()]
      .sort((left, right) => left.index - right.index)
      .map((block): JsonValue => ({
        blockId: block.blockId,
        type: block.type,
        index: block.index,
        text: block.text,
        completed: block.completed,
        ...(block.block === undefined ? {} : { block: block.block as unknown as JsonValue }),
      })),
  };
  return {
    ...message,
    metadata: { ...(message.metadata ?? {}), [ASSEMBLY_METADATA_KEY]: persisted },
  };
}

function withoutAssemblyMetadata(message: AgentMessageV2): AgentMessageV2 {
  if (message.metadata === undefined || !(ASSEMBLY_METADATA_KEY in message.metadata)) return message;
  const metadata = { ...message.metadata };
  delete metadata[ASSEMBLY_METADATA_KEY];
  if (Object.keys(metadata).length === 0) {
    const withoutMetadata = { ...message };
    delete withoutMetadata.metadata;
    return withoutMetadata;
  }
  return { ...message, metadata };
}

function readAssemblyMetadata(value: JsonValue | undefined, messageId: string): PersistedAssemblyStateV2 | undefined {
  if (value === undefined) return undefined;
  const object = jsonObject(value);
  if (object === undefined || object.version !== 1 || !isNonnegativeInteger(object.lastSequence) || !Array.isArray(object.blocks)) {
    throw new MessageAssemblyError(`message ${messageId} has invalid assembly metadata`);
  }
  return {
    version: 1,
    lastSequence: object.lastSequence,
    blocks: object.blocks.map((item, index) => readAssemblyBlock(item, messageId, index)),
  };
}

function readAssemblyBlock(value: JsonValue, messageId: string, position: number): PersistedAssemblyBlockV2 {
  const object = jsonObject(value);
  if (object === undefined
    || typeof object.blockId !== 'string'
    || !isMessageBlockType(object.type)
    || !isNonnegativeInteger(object.index)
    || typeof object.text !== 'string'
    || typeof object.completed !== 'boolean') {
    throw new MessageAssemblyError(`message ${messageId} has invalid assembly block at ${position}`);
  }
  let block: MessageBlockV2 | undefined;
  if (object.block !== undefined) {
    try {
      block = parseMessageBlockV2(object.block);
    } catch {
      throw new MessageAssemblyError(`message ${messageId} has an invalid completed assembly block at ${position}`);
    }
    if (block.blockId !== object.blockId || block.type !== object.type) {
      throw new MessageAssemblyError(`message ${messageId} has a mismatched assembly block at ${position}`);
    }
  }
  if (object.completed && block === undefined) {
    throw new MessageAssemblyError(`message ${messageId} has a completed assembly block without a block payload at ${position}`);
  }
  return {
    blockId: object.blockId,
    type: object.type,
    index: object.index,
    text: object.text,
    completed: object.completed,
    ...(block === undefined ? {} : { block }),
  };
}

function jsonObject(value: JsonValue): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function isNonnegativeInteger(value: JsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isMessageBlockType(value: JsonValue | undefined): value is WorkingBlockV2['type'] {
  return typeof value === 'string' && new Set<WorkingBlockV2['type']>([
    'text', 'reasoning_summary', 'tool_call', 'raw_tool_call', 'tool_result', 'evidence_ref', 'artifact_ref', 'image_ref',
    'context_summary', 'confirmation_request', 'confirmation_result', 'diagnosis', 'action_proposal', 'action_result', 'error',
  ]).has(value as WorkingBlockV2['type']);
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
