import type { MemoryFacade, MemoryItem, MemoryQuery } from '../contracts/index.js';

export class InMemoryMemoryFacade implements MemoryFacade {
  private readonly items: MemoryItem[] = [];

  public recall(query: MemoryQuery): Promise<MemoryItem[]> {
    const terms = query.text.toLowerCase().split(/\s+/u).filter(Boolean);
    return Promise.resolve(this.items
      .filter((item) => item.status === 'approved')
      .map((item) => ({
        ...item,
        score: terms.reduce((score, term) => score + (JSON.stringify(item.content).toLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((item) => (item.score ?? 0) > 0)
      .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
      .slice(0, query.limit));
  }

  public saveWorking(runId: string, content: Record<string, unknown>): Promise<void> {
    this.items.push({ id: `working:${runId}`, kind: 'working', status: 'observation', content });
    return Promise.resolve();
  }

  public recordCase(content: Record<string, unknown>): Promise<void> {
    this.items.push({ id: crypto.randomUUID(), kind: 'episodic', status: 'observation', content });
    return Promise.resolve();
  }

  public proposeExperience(content: Record<string, unknown>): Promise<void> {
    this.items.push({ id: crypto.randomUUID(), kind: 'procedural', status: 'observation', content });
    return Promise.resolve();
  }
}
