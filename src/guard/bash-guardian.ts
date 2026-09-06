import { isAbsolute, normalize, relative, resolve } from 'node:path';
import type { Finding, GuardInput, Guardian } from '../contracts/index.js';
import { finding } from './guard-engine.js';

const destructivePatterns = [
  /(?:^|\s)(?:rm|rmdir)\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i,
  /(?:^|\s)(?:format|mkfs|diskpart)\b/i,
  /(?:^|\s)git\s+(?:reset\s+--hard|clean\s+-[^\s]*f)/i,
  /(?:^|\s)(?:shutdown|reboot|Stop-Computer)\b/i,
];

export class BashGuardian implements Guardian {
  public readonly id = 'bash-policy';
  private readonly workspaceRoots: string[];

  public constructor(workspaceRoots: readonly string[], private readonly sensitivePaths: readonly string[] = []) {
    this.workspaceRoots = workspaceRoots.map((path) => normalize(resolve(path)));
  }

  public inspect(input: GuardInput): Promise<Finding[]> {
    if (input.tool.name !== 'bash') return Promise.resolve([]);
    const findings: Finding[] = [];
    const commandValue = input.toolCall.input.command;
    const cwdValue = input.toolCall.input.cwd;
    const command = typeof commandValue === 'string' ? commandValue : '';
    const cwd = typeof cwdValue === 'string' ? cwdValue : '';
    if (destructivePatterns.some((pattern) => pattern.test(command))) {
      findings.push(finding('bash.destructive-command', 'CRITICAL', '检测到破坏性命令。', input.tool.name));
    }
    if (!this.isInWorkspace(cwd)) {
      findings.push(finding('bash.outside-workspace', 'HIGH', '命令工作目录不在允许的工作区。', input.tool.name, { cwd }));
    }
    if (this.sensitivePaths.some((path) => command.toLowerCase().includes(normalize(path).toLowerCase()))) {
      findings.push(finding('bash.sensitive-path', 'CRITICAL', '命令引用了敏感路径。', input.tool.name));
    }
    return Promise.resolve(findings);
  }

  private isInWorkspace(path: string): boolean {
    if (!isAbsolute(path)) return false;
    const resolved = normalize(resolve(path));
    return this.workspaceRoots.some((root) => {
      const child = relative(root, resolved);
      return child === '' || (!child.startsWith('..') && !isAbsolute(child));
    });
  }
}
