import type { PublicRunDetail, RunUsageSummary } from '../api/types.js';
import type { PublicToolActivity } from '../state/run-view.js';
import type { ReactElement } from 'react';

export function RunStatus({ detail, descendantUsage, subtreeUsage, connected, pending, resumeAvailable, toolActivity, onResume }: { detail: PublicRunDetail | null; descendantUsage: RunUsageSummary | null; subtreeUsage: RunUsageSummary | null; connected: boolean; pending: boolean; resumeAvailable: boolean; toolActivity: PublicToolActivity | null; onResume: () => void }): ReactElement {
  return <section className="panel status-panel"><div className="panel-heading"><div><p className="eyebrow">RUN STATUS</p><h2>运行状态</h2></div>{connected && <span className="live-label">LIVE</span>}</div>
    {detail === null ? <div className="list-empty">打开一个 Run 查看状态。</div> : <>
      <div className="status-hero"><span className={`status-dot status-${detail.status}`} /><strong>{statusLabel(detail.status)}</strong><span>{detail.stage}</span></div>
      {toolActivity !== null && <div className="tool-block"><strong>{toolActivity.status === 'running' ? '工具执行中' : '工具结果'}</strong><code>{toolActivity.toolName} · {toolActivity.status}</code></div>}
      <dl className="detail-list"><div><dt>Run ID</dt><dd><code>{detail.runId}</code></dd></div><div><dt>上下文版本</dt><dd>{detail.contextVersion}</dd></div><div><dt>证据数量</dt><dd>{detail.evidenceIds.length}</dd></div></dl>
      <div className="token-usage"><strong>模型用量</strong><dl className="detail-list"><div><dt>本 Run</dt><dd>{formatUsage(detail.usage)}</dd></div><div><dt>子 Run 合计</dt><dd>{descendantUsage === null ? '无子 Run' : formatUsage(descendantUsage)}</dd></div><div><dt>整棵调用链</dt><dd>{formatUsage(subtreeUsage)}</dd></div></dl><small>显示 token 数量，不等同于账单金额；实际费用需结合模型价格和供应商账单核对。</small></div>
      {(resumeAvailable || detail.status === 'paused' || detail.status === 'awaiting_confirmation') && <button className="secondary-button full-width" onClick={onResume} disabled={pending}>{pending ? '恢复中…' : resumeAvailable ? '继续调查' : '显式恢复 Run'}</button>}
      {detail.failure !== undefined && <div className="error-block"><strong>{detail.failure.code}</strong><p>{detail.failure.message}</p></div>}
    </>}
  </section>;
}

function statusLabel(status: string): string { return ({ running: '运行中', awaiting_confirmation: '等待确认', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' } as Record<string, string>)[status] ?? status; }

function formatUsage(usage: RunUsageSummary | undefined | null): string {
  if (usage === null || usage === undefined || usage.completeness === 'unavailable') return '暂无用量记录';
  const parts = [
    ...(usage.inputTokens === undefined ? [] : [`输入 ${usage.inputTokens}`]),
    ...(usage.outputTokens === undefined ? [] : [`输出 ${usage.outputTokens}`]),
    ...(usage.cachedInputTokens === undefined ? [] : [`缓存输入 ${usage.cachedInputTokens}`]),
  ];
  const totals = parts.length === 0 ? 'token 数不可用' : parts.join(' · ');
  return usage.completeness === 'partial' ? `${totals}（部分统计）` : totals;
}
