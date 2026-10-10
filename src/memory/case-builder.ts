import type { MemoryCaptureRequest, DiagnosticMemoryCase, MemoryCaptureSource } from '../contracts/diagnostic-memory.js';
import { checkpointChecksum } from '../contracts/stable-json.js';
import { parseDiagnosticMemoryCase } from '../contracts/diagnostic-memory-schema.js';
import { MemoryError } from './memory-error.js';
import { memoryInstant, parseMemoryRequest } from './diagnostic-memory-state.js';
import { memoryScopeKey } from './memory-scope.js';

const DAY_MS = 86_400_000;
const SUMMARY_BYTES = 2 * 1024;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/u;
const PROMPT_INJECTION = /(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|忽略(?:之前|以上|所有)指令|系统提示词|system\s+prompt|developer\s+message/iu;
const SECRET = /\b(?:api[_-]?key|access[_-]?token|token|password|passwd|secret|cookie|authorization)\s*[:=]\s*[^\s,;]+|\bBearer\s+[^\s,;]+|\bsk-[A-Za-z0-9_-]{8,}/giu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const CN_MOBILE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/gu;
const INTERNAL_ADDRESS = /(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w.-]*\.internal)(?::\d+)?(?:\/\S*)?/giu;

type CaptureSource = Awaited<ReturnType<MemoryCaptureSource['load']>>;

/** Builds a bounded observation from only the persisted terminal assistant report and evidence metadata. */
export function buildMemoryCase(requestInput: MemoryCaptureRequest, source: CaptureSource, nowInput: string): DiagnosticMemoryCase {
  const request = parseMemoryRequest(requestInput);
  const now = memoryInstant(nowInput);
  const context = source.context;
  if (context.runId !== request.sourceRunId || context.contextVersion !== request.sourceContextVersion
    || context.status !== request.sourceRunStatus || context.memoryControl === undefined
    || memoryScopeKey(context.memoryControl.scope) !== memoryScopeKey(request.scope)
    || !['completed', 'failed', 'cancelled'].includes(context.status)) {
    throw new MemoryError('MEMORY_SOURCE_CONFLICT');
  }

  const report = finalAssistantText(context.messages);
  if (report !== undefined && PROMPT_INJECTION.test(report)) throw new MemoryError('MEMORY_DATA_INVALID');
  const safeReport = report === undefined ? '' : sanitizeReport(report);
  const fallback = context.status === 'completed'
    ? '本次巡检未生成可保存的最终诊断摘要；此记录不构成根因判断。'
    : '本次巡检未完成；此记录仅用于回顾调查状态，不构成诊断结论。';
  const summary = truncateUtf8(safeReport || fallback, SUMMARY_BYTES);
  if (summary.length === 0 || hasRecognizableSensitiveData(summary)) throw new MemoryError('MEMORY_DATA_INVALID');

  const withinEvidenceLimit = source.evidenceRefs.length <= 20;
  const evidenceRefs = source.evidenceRefs.slice(0, 20).map((reference) => ({ ...reference }));
  const refsBySource = new Set(evidenceRefs.map((reference) => reference.source));
  const requiredRefsPresent = withinEvidenceLimit && request.requiredSources.every((required) => refsBySource.has(required));
  const hasEvidence = evidenceRefs.length > 0;
  const quality = context.status !== 'completed' ? 'failed'
    : source.requiredEvidenceComplete && requiredRefsPresent && hasEvidence ? 'sufficient' : 'insufficient';

  const limitations = new Set<string>();
  for (const limitation of source.limitations.slice(0, 20)) {
    const candidate = limitation.trim().toUpperCase();
    limitations.add(CODE.test(candidate) ? candidate : 'SOURCE_LIMITATION_UNCLASSIFIED');
  }
  if (report === undefined) limitations.add('FINAL_DIAGNOSIS_UNAVAILABLE');
  if (!source.requiredEvidenceComplete || !requiredRefsPresent) limitations.add('REQUIRED_EVIDENCE_INCOMPLETE');
  if (!withinEvidenceLimit) limitations.add('EVIDENCE_REFERENCE_LIMIT_EXCEEDED');
  if (!hasEvidence) limitations.add('EVIDENCE_UNAVAILABLE');
  const limitationList = [...limitations].slice(0, 20);

  const symptomCodes = [...new Set(summary.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+/gu) ?? [])]
    .filter((value) => CODE.test(value)).slice(0, 20);
  const validUntil = new Date(Date.parse(now) + 30 * DAY_MS).toISOString();
  const base = {
    schemaVersion: 1 as const,
    id: request.candidateId,
    revision: 1,
    extractorVersion: 'episodic-v1' as const,
    scope: request.scope,
    sourceRunId: context.runId,
    sourceRunStatus: context.status,
    capturedAt: now,
    validUntil,
    status: 'observation' as const,
    quality,
    summary,
    symptomCodes,
    limitations: limitationList,
    evidenceRefs,
    diagnosisOnly: true as const,
    eligibleForPromotion: false,
  };
  return parseDiagnosticMemoryCase({ ...base, digest: checkpointChecksum(base) });
}

function finalAssistantText(messages: readonly { role: string; blocks: readonly { type: string; text?: string }[] }[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== 'assistant') return undefined;
  const text = last.blocks.filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '').join('\n').trim();
  return text.length === 0 ? undefined : text;
}

function sanitizeReport(value: string): string {
  let result = value.normalize('NFKC').replace(/\r\n?/gu, '\n');
  if (PROMPT_INJECTION.test(result)) throw new MemoryError('MEMORY_DATA_INVALID');
  result = result.replace(SECRET, '[REDACTED]').replace(EMAIL, '[REDACTED]')
    .replace(CN_MOBILE, '[REDACTED]').replace(INTERNAL_ADDRESS, '[REDACTED]');
  result = result.split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
  return result;
}

function hasRecognizableSensitiveData(value: string): boolean {
  SECRET.lastIndex = 0;
  EMAIL.lastIndex = 0;
  CN_MOBILE.lastIndex = 0;
  INTERNAL_ADDRESS.lastIndex = 0;
  return SECRET.test(value) || EMAIL.test(value) || CN_MOBILE.test(value) || INTERNAL_ADDRESS.test(value);
}

function truncateUtf8(value: string, maximum: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maximum) break;
    result += character;
    bytes += size;
  }
  return result.trim();
}
