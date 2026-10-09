import type { PublicMessageBlock, PublicMessageItem } from '../api/types.js';
import type { ReactElement } from 'react';
import { missingEvidenceLabel } from './missing-evidence-label.js';

export function MessageList({ messages }: { messages: readonly PublicMessageItem[] }): ReactElement {
  if (messages.length === 0) return <div className="list-empty">等待 Agent 产生公开消息…</div>;
  return <div className="message-list">{messages.map((item) => <article className={`message-card role-${item.message.role}`} key={item.message.id}>
    <div className="message-meta"><span>{roleLabel(item.message.role)}</span><time>{formatDate(item.message.createdAt)}</time>{item.truncated && <em>内容已截断</em>}</div>
    <div className="message-blocks">{item.message.blocks.map((block, index) => <MessageBlock block={block} key={block.blockId ?? `${item.message.id}-${index}`} />)}</div>
  </article>)}</div>;
}

function MessageBlock({ block }: { block: PublicMessageBlock }): ReactElement {
  switch (block.type) {
    case 'text': return <p className="message-text">{block.text}</p>;
    case 'reasoning_summary': return <div className="reasoning-block"><span>推理摘要</span><p>{block.summary}</p></div>;
    case 'tool_call': return <div className="tool-block"><strong>调用工具</strong><code>{block.call.name}</code></div>;
    case 'tool_result': return <div className="tool-block"><strong>工具结果</strong><span>{block.result.toolName} · {block.result.status}</span>{block.result.error !== undefined && <p>{block.result.error.message}</p>}</div>;
    case 'evidence_ref': return <div className="evidence-ref"><span>证据摘要</span><p>{block.summary}</p><small>{block.source} · {block.evidenceId}</small></div>;
    case 'context_summary': return <div className="summary-block"><strong>上下文摘要</strong><p>{block.summary.confirmedFacts.join('；') || '暂无已确认事实'}</p><small>缺失证据：{block.summary.missingEvidence.map(missingEvidenceLabel).join('；') || '无'}</small></div>;
    case 'confirmation_request': return <div className="confirm-inline"><strong>等待确认</strong><p>{block.riskSummary}</p></div>;
    case 'confirmation_result': return <div className="confirm-inline"><strong>确认结果：{block.decision}</strong><p>{block.toolCallIds.join('、')}</p></div>;
    case 'diagnosis': return <div className="diagnosis-block"><strong>诊断：{block.outcome}</strong>{block.rootCauseCandidates.map((candidate) => <p key={candidate.summary}>{candidate.summary}（{candidate.confidence}）</p>)}{block.missingEvidence.length > 0 && <small>仍缺少：{block.missingEvidence.map(missingEvidenceLabel).join('；')}</small>}</div>;
    case 'action_proposal': return <div className="action-block"><strong>动作建议（{block.risk}）</strong><p>{block.expectedEffect}</p><small>当前版本仅展示，不执行真实写操作。</small></div>;
    case 'error': return <div className="error-block"><strong>{block.error.code}</strong><p>{block.error.message}</p></div>;
    default: return <div className="unknown-block">该消息块类型暂不支持展示，已安全隐藏其内容。</div>;
  }
}

function roleLabel(role: string): string { return role === 'assistant' ? 'Agent' : role === 'tool' ? '工具' : role === 'user' ? '你' : '系统'; }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
