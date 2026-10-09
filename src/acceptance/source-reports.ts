import type { AgentEventEnvelopeV2, SourceSubagentResult, ToolResponseBlock } from '../contracts/index.js';
import { normalizeSourceReportMissingEvidenceCodes } from '../contracts/missing-evidence.js';

const SOURCE_BY_TOOL = {
  metrics_subagent: 'metrics',
  logs_subagent: 'logs',
} as const;
type AllowedToolName = keyof typeof SOURCE_BY_TOOL;
type AllowedSource = (typeof SOURCE_BY_TOOL)[AllowedToolName];

interface Invocation {
  source: AllowedSource;
  childRunId: string;
  parentRunId: string;
  toolCallId: string;
}

/** Extracts only structured reports whose parent tool result is tied to a source lifecycle. */
export function readSourceReports(events: readonly AgentEventEnvelopeV2[]): SourceSubagentResult[] {
  const starts = new Map<string, Invocation[]>();
  for (const event of events) {
    if (event.type !== 'SUBAGENT_STARTED') continue;
    const source = event.payload.subagentType;
    if (source !== 'metrics' && source !== 'logs') continue;
    const invocation: Invocation = {
      source,
      childRunId: event.payload.childRunId,
      parentRunId: event.payload.parentRunId,
      toolCallId: event.toolCallId ?? '',
    };
    const key = invocationKey(invocation);
    starts.set(key, [...(starts.get(key) ?? []), invocation]);
  }

  const reports: SourceSubagentResult[] = [];
  for (const event of events) {
    if (event.type !== 'TOOL_RESULT') continue;
    const result = event.payload.result;
    const source = sourceForTool(result.toolName);
    if (source === undefined || event.toolCallId === undefined || result.toolCallId !== event.toolCallId
      || result.response === undefined) continue;
    const invocation: Invocation = {
      source,
      childRunId: '',
      parentRunId: event.runId,
      toolCallId: event.toolCallId,
    };
    const candidates = [...starts.values()].flat().filter((candidate) => candidate.source === source
      && candidate.parentRunId === invocation.parentRunId && candidate.toolCallId === invocation.toolCallId);
    if (candidates.length !== 1) continue;
    const matched = candidates[0]!;
    const terminalEvents = events.filter((candidate): candidate is Extract<AgentEventEnvelopeV2,
      { type: 'SUBAGENT_COMPLETED' | 'SUBAGENT_FAILED' }> => (
      (candidate.type === 'SUBAGENT_COMPLETED' || candidate.type === 'SUBAGENT_FAILED')
      && candidate.runId === matched.childRunId
      && candidate.parentRunId === matched.parentRunId
      && candidate.toolCallId === matched.toolCallId
      && candidate.payload.childRunId === matched.childRunId
    ));
    if (terminalEvents.length !== 1) continue;
    const terminal = terminalEvents[0]!;
    const report = parseSourceReport(result.response.blocks, result.response.evidenceIds ?? [], source);
    if (report === undefined) continue;
    const responseEvidenceIds = uniqueStrings(result.response.evidenceIds ?? []);
    const blockEvidenceIds = uniqueStrings(result.response.blocks.flatMap((block) => (
      block.type === 'evidence_ref' ? [block.evidenceId] : []
    )));
    if (!sameStrings(report.evidenceIds, responseEvidenceIds) || !sameStrings(report.evidenceIds, blockEvidenceIds)) continue;
    if (terminal.type === 'SUBAGENT_FAILED') {
      if (report.status !== 'unavailable' || result.status !== 'failed') continue;
    } else {
      const expectedStatus = report.status === 'partial' ? 'partial' : 'completed';
      if (report.status === 'unavailable' || terminal.payload.status !== expectedStatus || result.status !== 'success') continue;
    }
    reports.push(report);
  }
  return reports;
}

export function isAllowedSourceToolName(value: string): value is AllowedToolName {
  return Object.hasOwn(SOURCE_BY_TOOL, value);
}

function sourceForTool(toolName: string): AllowedSource | undefined {
  return isAllowedSourceToolName(toolName) ? SOURCE_BY_TOOL[toolName] : undefined;
}

function parseSourceReport(
  blocks: readonly ToolResponseBlock[],
  responseEvidenceIds: readonly string[],
  expectedSource: AllowedSource,
): SourceSubagentResult | undefined {
  const jsonBlocks = blocks.filter((block): block is Extract<ToolResponseBlock, { type: 'json' }> => block.type === 'json');
  if (jsonBlocks.length !== 1) return undefined;
  const value = jsonBlocks[0]?.['value'];
  if (!isRecord(value) || value['source'] !== expectedSource
    || !isOneOf(value['status'], ['complete', 'partial', 'unavailable'])
    || typeof value['summary'] !== 'string' || !Array.isArray(value['findings'])
    || !isStringArray(value['evidenceIds']) || !isStringArray(value['businessTraceIds'])
    || !isStringArray(value['missingEvidence']) || !isFiniteBounded(value['coverage'], 0, 1)
    || !isSafeCount(value['toolCallsUsed']) || !isFiniteBounded(value['durationMs'], 0, Number.MAX_SAFE_INTEGER)) return undefined;
  if (value['summary'].length > 16_384 || value['findings'].length > 20
    || value['evidenceIds'].length > 20 || value['businessTraceIds'].length > 100
    || value['missingEvidence'].length > 20) return undefined;
  const findings: SourceSubagentResult['findings'] = [];
  for (const finding of value['findings']) {
    if (!isRecord(finding) || !isOneOf(finding['kind'], ['observation', 'inference'])
      || typeof finding['statement'] !== 'string' || finding['statement'].length > 4_096
      || !isStringArray(finding['evidenceIds'])) return undefined;
    findings.push({
      kind: finding['kind'],
      statement: finding['statement'],
      evidenceIds: uniqueStrings(finding['evidenceIds']),
    });
  }
  const evidenceIds = uniqueStrings(value['evidenceIds']);
  if (evidenceIds.length !== value['evidenceIds'].length
    || !sameStrings(evidenceIds, responseEvidenceIds)) return undefined;
  const missingEvidence = uniqueStrings(value['missingEvidence']);
  const declaredMissingEvidenceCodes = value['missingEvidenceCodes'] === undefined
    ? undefined
    : isStringArray(value['missingEvidenceCodes']) && value['missingEvidenceCodes'].length <= 20
      ? value['missingEvidenceCodes']
      : ['unclassified_evidence_gap'];
  return {
    source: expectedSource,
    status: value['status'],
    summary: value['summary'],
    findings,
    evidenceIds,
    businessTraceIds: uniqueStrings(value['businessTraceIds']),
    missingEvidence,
    missingEvidenceCodes: normalizeSourceReportMissingEvidenceCodes(
      expectedSource, missingEvidence, declaredMissingEvidenceCodes,
    ),
    coverage: value['coverage'],
    toolCallsUsed: value['toolCallsUsed'],
    durationMs: value['durationMs'],
  };
}

function invocationKey(value: Invocation): string {
  return `${value.source}\u0000${value.parentRunId}\u0000${value.childRunId}\u0000${value.toolCallId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 4_096);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteBounded(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isOneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}
