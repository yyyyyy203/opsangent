import type { ReactElement } from 'react';

export function SubagentPanel({ childRunIds, onOpen }: { childRunIds: readonly string[]; onOpen: (runId: string) => void }): ReactElement {
  return <section className="panel subagent-panel"><div className="panel-heading"><div><p className="eyebrow">SUBAGENTS</p><h2>子调查</h2></div><span className="count-badge">{childRunIds.length}</span></div>
    {childRunIds.length === 0 ? <div className="list-empty">当前 Run 没有子调查。</div> : <div className="child-list">{childRunIds.slice(0, 4).map((runId) => <button key={runId} onClick={() => onOpen(runId)}><span className="status-dot status-running" /><span><strong>Source Subagent</strong><small>{runId}</small></span><span>→</span></button>)}</div>}
  </section>;
}
