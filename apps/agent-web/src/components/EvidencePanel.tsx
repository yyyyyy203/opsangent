import type { PublicEvidenceView } from '../api/types.js';
import type { ReactElement } from 'react';
import { missingEvidenceLabel } from './missing-evidence-label.js';

export function EvidencePanel({ evidence, missingEvidence, incomplete = false }: { evidence: readonly PublicEvidenceView[]; missingEvidence: readonly string[]; incomplete?: boolean }): ReactElement {
  return <section className="panel evidence-panel"><div className="panel-heading"><div><p className="eyebrow">EVIDENCE</p><h2>证据摘要</h2></div><span className="count-badge">{evidence.length}</span></div>
    {evidence.length === 0 && missingEvidence.length === 0 && <div className="list-empty">暂无证据摘要。</div>}
    {evidence.map((item) => <div className="evidence-card" key={item.evidenceId}><div className="evidence-title"><strong>{item.source}</strong><span>{item.state}</span></div><p>{summaryText(item.summary)}</p><small>Run {item.runId} · 引用 {item.evidenceId} · {item.recordCount ?? 0} 条记录</small></div>)}
    {incomplete && <div className="missing-box"><strong>证据列表不完整</strong><p>部分子 Run 或证据分页暂时无法读取；当前仍只展示已成功读取的摘要和引用。</p></div>}
    {missingEvidence.length > 0 && <div className="missing-box"><strong>仍缺少的证据</strong><p>{missingEvidence.map(missingEvidenceLabel).join('；')}</p></div>}
    <p className="privacy-note">页面只展示证据摘要和元数据，原始 ELK/日志内容不会进入浏览器。</p>
  </section>;
}

function summaryText(summary: Record<string, unknown>): string {
  const values = Object.entries(summary).slice(0, 3).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  return values.join(' · ') || '已采集证据，但暂无公开摘要。';
}
