import { Check, GitCommitHorizontal, LoaderCircle } from 'lucide-react';
import { STAGES } from '../types/events';
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
