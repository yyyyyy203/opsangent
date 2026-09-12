import type { Tool, ToolCallReturn } from '../../contracts/index.js';

export interface SkillDescriptor {
  name: string;
  description: string;
  inputSchema: Tool['inputSchema'];
  execute?: (input: Record<string, unknown>, signal: AbortSignal) => ToolCallReturn;
}

export function adaptSkillTool(skill: SkillDescriptor): Tool {
  return {
    name: `skill.${skill.name}`,
    description: skill.description,
    kind: 'utility',
    source: 'skill',
    inputSchema: skill.inputSchema,
    ...(skill.execute === undefined ? {} : {
      call: (input, options) => skill.execute?.(input, options.signal) as ToolCallReturn,
    }),
    userFacingLabel: () => `执行技能：${skill.name}`,
    isConcurrencySafe: () => false,
  };
}
