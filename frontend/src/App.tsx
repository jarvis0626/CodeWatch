import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, Info, TriangleAlert } from 'lucide-react';
import { BuildHeader, Topbar } from './components/BuildHeader';
import { Sidebar } from './components/Sidebar';
import { BuildStats } from './components/BuildStats';
import { ArchitectureGraph } from './components/ArchitectureGraph';
import { CurrentAction } from './components/CurrentAction';
import { AgentTimeline } from './components/AgentTimeline';
import { FileChanges } from './components/FileChanges';
import { TestResults } from './components/TestResults';
import { EventLog } from './components/EventLog';
import { useAgentEvents } from './hooks/useAgentEvents';
import { DEFAULT_PROMPT } from './config';

export default function App() {
  const { state, start, reset } = useAgentEvents();
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [now, setNow] = useState(Date.now());
  const live = state.connection === 'streaming';
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  const seconds = state.startedAt
    ? Math.max(0, Math.floor(((state.finishedAt ?? now) - state.startedAt) / 1000))
    : 0;
  const elapsed = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  return (
    <>
      <Topbar connection={state.connection} />
      <div className="app-shell">
        <Sidebar />
        <main>
          <BuildHeader
            prompt={prompt}
            setPrompt={setPrompt}
            connection={state.connection}
            start={() => start(prompt)}
            reset={reset}
          />
          {state.error && (
            <div className="notice error-notice" role="alert">
              <TriangleAlert size={16} />
              <span>{state.error}</span>
              <button onClick={() => start(prompt)}>Try again</button>
            </div>
          )}
          {state.connection === 'complete' && (
            <div className="notice success-notice" role="status">
              <CheckCircle2 size={16} />
              <span>
                <strong>Build complete.</strong> All layers connected. All 3 tests passing.
              </span>
              <span>{elapsed}</span>
            </div>
          )}
          <BuildStats state={state} />
          <div className="section-label">
            <span>
              <span className={`status-dot ${live ? 'live-dot' : ''}`} />
              {live
                ? 'BUILD IN PROGRESS'
                : state.connection === 'complete'
                  ? 'BUILD COMPLETE'
                  : state.connection === 'error'
                    ? 'BUILD INTERRUPTED'
                    : 'BUILD OBSERVATORY'}
            </span>
            <span>
              <Clock3 size={12} />
              {elapsed}
              <span className="section-divider">/</span>
              {state.runId ? `RUN ${state.runId.slice(4, 10).toUpperCase()}` : 'NO ACTIVE RUN'}
            </span>
          </div>
          <div className="dashboard-grid">
            <ArchitectureGraph
              key={state.runId ?? 'idle'}
              nodes={state.nodes}
              edges={state.edges}
              live={live}
              runId={state.runId}
            />
            <div className="agent-column">
              <CurrentAction state={state} />
              <AgentTimeline state={state} />
            </div>
            <div className="detail-grid">
              <FileChanges files={state.files} />
              <TestResults tests={state.tests} />
            </div>
            <EventLog
              key={`log-${state.runId ?? 'idle'}`}
              events={state.events}
              commands={state.commands}
              runId={state.runId}
              live={live}
            />
          </div>
          <footer className="main-footer">
            <span>
              <Info size={12} />
              This is a simulation. Files, commands, and test results are illustrative.
            </span>
            <span>Built to make the invisible visible.</span>
          </footer>
        </main>
      </div>
    </>
  );
}
