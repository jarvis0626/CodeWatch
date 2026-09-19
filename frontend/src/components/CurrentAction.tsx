import { Activity, Bot, FileCode2, Terminal } from 'lucide-react';
import type { BuildState } from '../state/build';
import { sourceLabel } from '../types/events';

export function CurrentAction({ state }: { state: BuildState }) {
  const { current, stage, connection } = state;
  const path = current && 'path' in current.data ? current.data.path : null;
  const test = current && 'name' in current.data ? current.data.name : null;
  const command = current && 'command' in current.data ? current.data.command : null;
  const status = connection === 'error' ? 'failed' : (current?.status ?? 'pending');
  const demo = state.mode === 'demo';
  const latestReport = state.agentReport;
  return (
    <section className="panel current-panel" aria-labelledby="action-title">
      <header className="panel-header">
        <h2 id="action-title">
          <Activity size={15} />
          Current activity
        </h2>
        <span className="tiny-label">{demo ? 'SIMULATOR' : 'REAL PROJECT'}</span>
      </header>
      <div className="current-body">
        <div className="current-stage-line">
          <span className="eyebrow">{demo ? 'CURRENT STAGE' : 'REPORTED STAGE'}</span>
          <span
            className={`badge ${connection === 'complete' ? 'completed' : connection === 'error' ? 'failed' : stage ? 'active' : 'planned'}`}
            data-testid="current-stage"
          >
            {demo && connection === 'error' ? 'INTERRUPTED' : (stage ?? (demo ? 'IDLE' : 'NOT REPORTED'))}
          </span>
        </div>
        <div className="agent-action">
          <div className={`agent-avatar ${connection === 'streaming' ? 'agent-working' : ''}`}>
            <Bot size={20} />
          </div>
          <div>
            <span className="action-agent">
              {demo ? 'CodeWatch Agent' : current?.source === 'agent' ? current.agentName || 'Connected agent' : current?.source === 'filesystem' ? 'Filesystem observer' : 'CodeWatch'} <span className="mini-dot" />
            </span>
            <p data-testid="current-action">
              {current?.data.message ?? (connection === 'error'
                ? 'Waiting to reconnect to the event stream.'
                : demo ? 'Ready when you are. Start a build and follow every step here.' : 'Connect a project to see real changes. Add the AI integration to see its plan and progress.')}
            </p>
          </div>
        </div>
        {!demo && <div className={`source-badge source-${current?.source ?? 'system'}`}>{current ? sourceLabel(current.source) : 'Waiting for activity'}</div>}
        {latestReport && latestReport.eventId !== current?.eventId && <div className="latest-report"><span className="eyebrow">LATEST AGENT REPORT</span><p>{latestReport.data.message}</p></div>}
        {(path || test || command) && (
          <div className="action-target">
            <span className="eyebrow">{path ? 'FILE' : test ? 'TEST' : 'COMMAND'}</span>
            <code>
              {command ? <Terminal size={12} /> : <FileCode2 size={12} />}
              {path || test || command}
            </code>
          </div>
        )}
        <div className="action-metadata">
          <span>
            Event type<code>{current?.type ?? '—'}</code>
          </span>
          <span>
            Status
            <span className={`status-text ${status}`}>
              <span className="status-dot" />
              {status}
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}
