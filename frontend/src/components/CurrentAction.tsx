import { Activity, Bot, FileCode2, Terminal } from 'lucide-react';
import type { BuildState } from '../state/build';

export function CurrentAction({ state }: { state: BuildState }) {
  const { current, stage, connection } = state;
  const path = current && 'path' in current.data ? current.data.path : null;
  const test = current && 'name' in current.data ? current.data.name : null;
  const command = current && 'command' in current.data ? current.data.command : null;
  const status = connection === 'error' ? 'failed' : (current?.status ?? 'pending');
  return (
    <section className="panel current-panel" aria-labelledby="action-title">
      <header className="panel-header">
        <h2 id="action-title">
          <Activity size={15} />
          Agent activity
        </h2>
        <span className="tiny-label">SIMULATOR</span>
      </header>
      <div className="current-body">
        <div className="current-stage-line">
          <span className="eyebrow">CURRENT STAGE</span>
          <span
            className={`badge ${connection === 'complete' ? 'completed' : connection === 'error' ? 'failed' : stage ? 'active' : 'planned'}`}
            data-testid="current-stage"
          >
            {connection === 'error' ? 'INTERRUPTED' : (stage ?? 'IDLE')}
          </span>
        </div>
        <div className="agent-action">
          <div className={`agent-avatar ${connection === 'streaming' ? 'agent-working' : ''}`}>
            <Bot size={20} />
          </div>
          <div>
            <span className="action-agent">
              CodeWatch Agent <span className="mini-dot" />
            </span>
            <p data-testid="current-action">
              {connection === 'error'
                ? 'The build stream was interrupted.'
                : (current?.data.message ??
                  'Ready when you are. Start a build and follow every step here.')}
            </p>
          </div>
        </div>
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
