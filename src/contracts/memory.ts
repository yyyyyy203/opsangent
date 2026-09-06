export interface MemoryQuery {
  profileId: string;
  service?: string;
  faultType?: string;
  text: string;
  limit: number;
}

export interface MemoryItem {
  id: string;
  kind: 'working' | 'episodic' | 'semantic' | 'procedural';
  status: 'observation' | 'approved' | 'rejected';
  content: Record<string, unknown>;
  score?: number;
}

export interface MemoryFacade {
  recall(query: MemoryQuery): Promise<MemoryItem[]>;
  saveWorking(runId: string, content: Record<string, unknown>): Promise<void>;
  recordCase(content: Record<string, unknown>): Promise<void>;
  proposeExperience(content: Record<string, unknown>): Promise<void>;
}
