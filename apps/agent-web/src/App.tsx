import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { ApiClient } from './api/client.js';
import { RunViewController } from './state/run-view.js';
import { ConfirmationCard } from './components/ConfirmationCard.js';
import { EvidencePanel } from './components/EvidencePanel.js';
import { MessageList } from './components/MessageList.js';
import { RunList } from './components/RunList.js';
import { RunStatus } from './components/RunStatus.js';
import { SubagentPanel } from './components/SubagentPanel.js';
import { TaskComposer } from './components/TaskComposer.js';

export default function App(): ReactElement {
  const controller = useMemo(() => new RunViewController(new ApiClient({
    baseUrl: typeof import.meta.env.VITE_AGENT_API_URL === 'string' && import.meta.env.VITE_AGENT_API_URL.length > 0
      ? import.meta.env.VITE_AGENT_API_URL
      : 'http://127.0.0.1:4100',
  })), []);
  const state = useSyncExternalStore(controller.subscribe.bind(controller), controller.getState.bind(controller), controller.getState.bind(controller));
  const [selectedProfile, setSelectedProfile] = useState('');

  useEffect(() => {
    void controller.loadIndex();
    return () => controller.close();
  }, [controller]);

  useEffect(() => {
    if (selectedProfile === '' && state.profiles[0] !== undefined) setSelectedProfile(state.profiles[0].id);
  }, [selectedProfile, state.profiles]);

  async function selectRun(runId: string): Promise<void> {
    await controller.openRun(runId);
  }

  async function startRun(message: string): Promise<void> {
    if (selectedProfile === '') return;
    await controller.startRun(message, selectedProfile);
    await controller.loadIndex();
  }

  const selectedProfileDescription = state.profiles.find((profile) => profile.id === selectedProfile)?.description;
  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AGENTOPS / LOCAL WORKSPACE</p>
          <h1>巡检 Agent 工作台</h1>
        </div>
        <div className={`connection-pill ${state.connected ? 'is-live' : ''}`}>
          <span className="connection-dot" />
          {state.connected ? '实时连接中' : '未连接'}
        </div>
      </header>

      {state.notice !== null && <div className="notice" role="status">{state.notice}</div>}

      <section className="workspace-grid">
        <aside className="panel run-history">
          <div className="panel-heading"><div><p className="eyebrow">RUNS</p><h2>巡检历史</h2></div><span className="count-badge">{state.runs.length}</span></div>
          <RunList runs={state.runs} selectedRunId={state.runId} onSelect={(runId) => void selectRun(runId)} />
        </aside>

        <section className="main-column">
          <TaskComposer
            profiles={state.profiles}
            selectedProfile={selectedProfile}
            profileDescription={selectedProfileDescription}
            pending={state.pendingCommand === 'start'}
            onProfileChange={setSelectedProfile}
            onSubmit={startRun}
          />
          <div className="panel message-panel">
            <div className="panel-heading"><div><p className="eyebrow">PUBLIC MESSAGES</p><h2>{state.runId === null ? '请选择一个 Run' : '调查过程'}</h2></div>{state.detail !== null && <span className="stage-chip">{state.detail.stage}</span>}</div>
            {state.runId === null ? <EmptyState title="从左侧打开历史，或提交一次新的巡检。" /> : <MessageList messages={state.messages} />}
          </div>
        </section>

        <aside className="side-column">
          <RunStatus detail={state.detail} descendantUsage={state.descendantUsage} subtreeUsage={state.subtreeUsage} connected={state.connected} pending={state.pendingCommand === 'resume'} resumeAvailable={state.resumeRequired} toolActivity={state.toolActivity} onResume={() => void controller.resumeRun()} />
          <ConfirmationCard confirmation={state.confirmation} pending={state.pendingCommand === 'confirmation'} onDecision={(confirmed, reason) => {
            if (state.confirmation === null) return;
            void controller.decideConfirmation({ toolCallId: state.confirmation.toolCallId, confirmed, expectedRevision: state.confirmation.expectedRevision, ...(reason === undefined ? {} : { reason }) });
          }} />
          <EvidencePanel evidence={state.evidence} missingEvidence={state.detail?.missingEvidence ?? []} incomplete={state.evidenceIncomplete} />
          <SubagentPanel childRunIds={state.detail?.childRunIds ?? []} onOpen={(runId) => void selectRun(runId)} />
        </aside>
      </section>
    </main>
  );
}

function EmptyState({ title }: { title: string }): ReactElement {
  return <div className="empty-state"><div className="empty-icon">⌁</div><p>{title}</p></div>;
}
