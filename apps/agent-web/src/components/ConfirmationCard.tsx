import type { PublicConfirmation } from '../api/types.js';
import type { ReactElement } from 'react';

export function ConfirmationCard({ confirmation, pending, onDecision }: { confirmation: PublicConfirmation | null; pending: boolean; onDecision: (confirmed: boolean, reason?: string) => void }): ReactElement {
  if (confirmation === null) return <section className="panel confirmation-panel"><div className="panel-heading"><div><p className="eyebrow">HITL</p><h2>人工确认</h2></div></div><div className="list-empty">当前没有待确认动作。</div></section>;
  return <section className="panel confirmation-panel"><div className="panel-heading"><div><p className="eyebrow">HITL / REQUIRED</p><h2>需要你的确认</h2></div><span className="risk-label">受控</span></div>
    <div className="confirmation-copy"><strong>{confirmation.summary}</strong><p>工具调用：<code>{confirmation.toolCallId}</code></p>{confirmation.expiresAt !== undefined && <small>有效期至 {confirmation.expiresAt}</small>}</div>
    <div className="confirmation-actions"><button className="primary-button" onClick={() => onDecision(true)} disabled={pending}>{pending ? '提交中…' : '批准'}</button><button className="secondary-button" onClick={() => onDecision(false, '用户在 Web 工作台拒绝')} disabled={pending}>拒绝</button></div>
    <p className="privacy-note">确认只作用于当前 toolCallId 和当前 revision，不会默认放行同名工具。</p>
  </section>;
}
