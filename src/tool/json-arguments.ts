export type JsonArgumentsResult =
  | { ok: true; value: Record<string, unknown>; repairs: string[] }
  | { ok: false; reason: string };

/** Repair only framing and trailing commas outside quoted strings. */
function repairSyntax(raw: string): { text: string; repairs: string[] } {
  let text = raw;
  const repairs: string[] = [];
  if (text.startsWith('\uFEFF')) { text = text.slice(1); repairs.push('bom'); }
  const fence = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  if (fence) { text = fence[1] ?? ''; repairs.push('code_fence'); }
  let quoted = false;
  let escaped = false;
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quoted) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    if (char === ',' && /^\s*[}\]]/.test(text.slice(index + 1))) {
      if (!repairs.includes('trailing_comma')) repairs.push('trailing_comma');
      continue;
    }
    output += char;
  }
  return { text: output, repairs };
}

function parse(text: string, maxDepth: number): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('object_required');
  // JSON.parse has already checked grammar. Tokenize to reject duplicate decoded keys,
  // including escaped keys, before they can be silently overwritten.
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  const stack: Array<Set<string> | null> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token && /^-?\d/.test(token) && !Number.isFinite(Number(token))) throw new Error('non_finite_number');
    if (token === '{' || token === '[') {
      stack.push(token === '{' ? new Set<string>() : null);
      if (stack.length > maxDepth) throw new Error('depth_limit');
    } else if (token === '}' || token === ']') stack.pop();
    else if (token?.startsWith('"') && tokens[index + 1] === ':') {
      const key = JSON.parse(token) as string;
      const keys = stack.at(-1);
      if (keys?.has(key)) throw new Error('duplicate_key');
      // Dangerous keys are not useful tool arguments and complicate downstream merging.
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('unsafe_key');
      keys?.add(key);
    }
  }
  return value as Record<string, unknown>;
}

export function parseJsonArguments(raw: string, maxBytes = 65_536, maxDepth = 32): JsonArgumentsResult {
  if (new TextEncoder().encode(raw).length > maxBytes) return { ok: false, reason: 'byte_limit' };
  try { return { ok: true, value: parse(raw, maxDepth), repairs: [] }; }
  catch (error) {
    if (error instanceof Error && !(error instanceof SyntaxError)) return { ok: false, reason: error.message };
  }
  const repaired = repairSyntax(raw);
  try { return { ok: true, value: parse(repaired.text, maxDepth), repairs: repaired.repairs }; }
  catch (error) {
    return { ok: false, reason: error instanceof SyntaxError ? 'invalid_json' : error instanceof Error ? error.message : 'invalid_json' };
  }
}
