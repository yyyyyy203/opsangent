import { projectGeneralMissingEvidenceCodes } from '../../../../src/contracts/missing-evidence.js';

const MISSING_EVIDENCE_LABELS: Readonly<Record<string, string>> = {
  unclassified_evidence_gap: '存在未分类的补充取证需求（尚未核实）',
};

export function missingEvidenceLabel(code: string): string {
  const safeCode = projectGeneralMissingEvidenceCodes([code])[0] ?? 'unclassified_evidence_gap';
  return MISSING_EVIDENCE_LABELS[safeCode] ?? safeCode;
}
