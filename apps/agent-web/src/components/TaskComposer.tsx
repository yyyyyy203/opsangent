import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import type { PublicProfile } from '../api/types.js';

export function TaskComposer({ profiles, selectedProfile, profileDescription, pending, onProfileChange, onSubmit }: {
  profiles: readonly PublicProfile[];
  selectedProfile: string;
  profileDescription: string | undefined;
  pending: boolean;
  onProfileChange: (profileId: string) => void;
  onSubmit: (message: string) => Promise<void>;
}): ReactElement {
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (message.trim().length === 0 || pending) return;
    await onSubmit(message.trim());
    setMessage('');
  }
  return <form className="panel composer" onSubmit={(event) => void submit(event)}>
    <div className="panel-heading"><div><p className="eyebrow">NEW INSPECTION</p><h2>开始一次巡检</h2></div><span className="readonly-label">只读模式</span></div>
    <label className="field-label" htmlFor="profile">目标 Profile</label>
    <select id="profile" value={selectedProfile} onChange={(event) => onProfileChange(event.target.value)} disabled={pending}>
      {profiles.length === 0 ? <option value="">等待服务配置…</option> : profiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
    </select>
    {profileDescription !== undefined && <p className="field-hint">{profileDescription}</p>}
    <label className="field-label" htmlFor="task">巡检问题</label>
    <textarea id="task" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="例如：检查结算失败率是否升高，并收集相关证据。" rows={4} disabled={pending} />
    <div className="composer-footer"><span className="safe-note">Agent 只读取已配置的数据源，不执行真实写操作。</span><button className="primary-button" type="submit" disabled={pending || message.trim().length === 0 || selectedProfile === ''}>{pending ? '启动中…' : '开始巡检'}</button></div>
  </form>;
}
