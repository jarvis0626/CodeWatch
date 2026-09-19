import { Check, GitCommitHorizontal, LoaderCircle } from 'lucide-react';
import { STAGES, sourceLabel } from '../types/events';
import type { BuildState } from '../state/build';

const descriptions = {
  PLANNING: 'Map the application',
  EXPLORING: 'Inspect the workspace',
  IMPLEMENTING: 'Create files & services',
  RUNNING: 'Install dependencies',
  TESTING: 'Run the test suite',
  DEBUGGING: 'Investigate & fix',
  VALIDATING: 'Check the architecture',
  COMPLETE: 'Ready to ship',
};

export function AgentTimeline({ state }: { state: BuildState }) {
  const complete = state.connection === 'complete';
  const seen = new Set(state.visits.map((visit) => visit.stage));
  if (state.mode === 'live') return <section className="panel timeline-panel" aria-labelledby="timeline-title"><header className="panel-header"><h2 id="timeline-title"><GitCommitHorizontal size={16} />Activity timeline</h2><span className="tiny-label">{state.visits.length} STAGE UPDATES</span></header>{state.visits.length ? <ol className="timeline live-timeline">{state.visits.map((visit, index) => <li key={visit.sequence} className={index === state.visits.length - 1 ? 'current' : 'visited'} data-stage={visit.stage}><span className="timeline-marker">{index === state.visits.length - 1 ? <GitCommitHorizontal size={11} /> : <Check size={11} />}</span><div><span className="timeline-name">{visit.stage.toLowerCase()}</span><small>{sourceLabel(visit.source)} · {new Date(visit.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small><p>{visit.message}</p></div></li>)}</ol> : <div className="empty-state"><GitCommitHorizontal size={23} /><strong>No stages reported yet</strong><p>Connect the AI integration to see its actual steps as it works.</p></div>}</section>;
  return (
    <section className="panel timeline-panel" aria-labelledby="timeline-title">
      <header className="panel-header">
        <h2 id="timeline-title">
          <GitCommitHorizontal size={16} />
          Build timeline
        </h2>
        <span className="tiny-label">{seen.size} / 8</span>
      </header>
      <ol className="timeline">
        {STAGES.map((stage, index) => {
          const active = state.stage === stage && !complete;
          const visited = seen.has(stage) && !active;
          const count = state.visits.filter((visit) => visit.stage === stage).length;
          return (
            <li
              key={stage}
              className={`${active ? 'current' : visited ? 'visited' : 'upcoming'}`}
              data-stage={stage}
              aria-current={active ? 'step' : undefined}
            >
              <span className="timeline-marker">
                {visited ? (
                  <Check size={11} />
                ) : active ? (
                  <LoaderCircle
                    size={12}
                    className={state.connection === 'streaming' ? 'spin' : ''}
                  />
                ) : (
                  <span>{String(index + 1).padStart(2, '0')}</span>
                )}
              </span>
              <div>
                <span className="timeline-name">
                  {stage.toLowerCase()}
                  {count > 1 && <span className="rerun-badge">RERUN</span>}
                </span>
                <small>{descriptions[stage]}</small>
              </div>
              {active && <span className="timeline-active-dot" />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
