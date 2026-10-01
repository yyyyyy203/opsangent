import type { PublicRunSummary } from '../api/types.js';
import type { ReactElement } from 'react';

export function RunList({ runs, selectedRunId, onSelect }: { runs: readonly PublicRunSummary[]; selectedRunId: string | null; onSelect: (runId: string) => void }): ReactElement {
  if (runs.length === 0) return <div className="list-empty">还没有巡检记录。</div>;
  return <div className="run-list">{runs.map((run) => <button className={`run-card ${run.runId === selectedRunId ? 'selected' : ''}`} key={run.runId} onClick={() => onSelect(run.runId)}>
    <span className={`status-dot status-${run.status}`} />
    <span className="run-card-body"><strong>{run.profileId}</strong><small>{run.stage} · {formatDate(run.updatedAt)}</small><code>{run.runId}</code></span>
  </button>)}</div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
