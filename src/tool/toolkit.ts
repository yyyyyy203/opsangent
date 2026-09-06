import type { Tool } from '../contracts/index.js';

export class Toolkit {
  private readonly tools = new Map<string, Tool>();

  public register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public list(): Tool[] {
    return [...this.tools.values()];
  }
}
