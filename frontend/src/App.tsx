import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, FlaskConical, Info, Radio, TriangleAlert } from 'lucide-react';
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
import { DEFAULT_PROMPT, PRODUCT_NAME } from './config';
import { useLiveEvents } from './hooks/useLiveEvents';
import { IntegrationPanel, ProjectConnection } from './components/ProjectConnection';
import { DesktopControls } from './components/DesktopControls';
import { ActivityFlow } from './components/ActivityFlow';
import { useDesktopPreferences } from './hooks/useDesktopPreferences';

export default function App() {
  const [mode, setMode] = useState<'live' | 'demo'>('live');
  const demo = useAgentEvents();
  const monitor = useLiveEvents();
  const { start, reset } = demo;
  const state = mode === 'live' ? monitor.state : demo.state;
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const { preferences, setPreferences } = useDesktopPreferences();
  const compact = !!preferences?.compact;
  const [windowError, setWindowError] = useState('');
  const [fileFocus, setFileFocus] = useState<{ path: string } | null>(null);
  useEffect(() => { setFileFocus(null); }, [state.runId]);
  async function focusFile(path: string) {
    if (compact && window.codewatchDesktop) {
      try { setPreferences(await window.codewatchDesktop.setPreferences({ compact: false })); }
      catch { setWindowError('Could not open the full app. Please try again.'); return; }
    }
    setFileFocus({ path });
  }
  useEffect(() => {
    if (fileFocus && !compact) document.getElementById('architecture')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [fileFocus, compact]);
  const [now, setNow] = useState(Date.now());
  const live = state.connection === 'streaming' && (mode === 'demo' || !!state.session?.watching);
  const error = mode === 'live' ? monitor.requestError || state.error : state.error;
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
      {!compact && <Topbar connection={state.connection} />}
      <div className={`app-shell ${compact ? 'companion-shell' : ''}`} data-testid="app-view" data-view={compact ? 'companion' : 'full'}>
        {!compact && <Sidebar mode={mode} session={state.session} />}
        <main>
          <div className={`workspace-toolbar ${compact ? 'companion-toolbar' : ''}`}><span className={compact ? 'companion-brand' : 'eyebrow'}>{compact ? PRODUCT_NAME : 'CODEWATCH / OBSERVATORY'}</span><div className="workspace-controls"><DesktopControls preferences={preferences} onPreferencesChange={setPreferences} />{!compact && <div className="mode-switch" role="group" aria-label="Workspace mode"><button className={mode === 'live' ? 'active' : ''} aria-pressed={mode === 'live'} onClick={() => { reset(); setMode('live'); }}><Radio size={12} />Live project</button><button className={mode === 'demo' ? 'active' : ''} aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}><FlaskConical size={12} />Demo</button></div>}</div></div>
          {windowError && <div className="notice error-notice" role="alert">{windowError}</div>}
          {compact && error && <div className="notice error-notice" role="alert">{error}</div>}
          {(mode === 'live' || compact) && <ActivityFlow key={`flow-${state.runId ?? 'idle'}`} state={state} compact={compact} onSelectFile={(path) => void focusFile(path)} />}
          {!compact && <>
          {mode === 'live' ? <ProjectConnection session={state.session} busy={monitor.busy} watch={monitor.watch} stop={monitor.stop} /> : <BuildHeader
            prompt={prompt}
            setPrompt={setPrompt}
            connection={state.connection}
            start={() => start(prompt)}
            reset={reset}
          />}
          {error && (
            <div className="notice error-notice" role="alert">
              <TriangleAlert size={16} />
              <span>{error}</span>
              {mode === 'demo' && <button onClick={() => start(prompt)}>Try again</button>}
            </div>
          )}
          {mode === 'live' && <IntegrationPanel />}
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
                ? mode === 'live' ? 'WATCHING FOR CHANGES' : 'BUILD IN PROGRESS'
                : state.connection === 'complete'
                  ? 'BUILD COMPLETE'
                  : state.connection === 'error'
                    ? 'RECONNECTING'
                    : mode === 'live' ? state.session ? 'WATCHER STOPPED' : 'CONNECT YOUR PROJECT' : 'BUILD OBSERVATORY'}
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
              projectName={mode === 'demo' ? 'todo-app' : state.session?.projectName}
              mode={mode}
              files={state.files}
              focusRequest={fileFocus}
            />
            <div className="agent-column">
              <CurrentAction state={state} />
              <AgentTimeline state={state} />
            </div>
            <div className="detail-grid">
              <FileChanges files={state.files} onSelectFile={mode === 'live' ? focusFile : undefined} />
              <TestResults tests={state.tests} mode={mode} />
            </div>
            <EventLog
              key={`log-${state.runId ?? 'idle'}`}
              events={state.events}
              commands={state.commands}
              runId={state.runId}
              live={live}
              mode={mode}
            />
          </div>
          <footer className="main-footer">
            <span>
              <Info size={12} />
              {mode === 'demo' ? 'This is a simulation. Files, commands, and test results are illustrative.' : 'Observed changes and agent reports are labeled separately. CodeWatch runs on your machine.'}
            </span>
            <span>Built to make the invisible visible.</span>
          </footer>
          </>}
        </main>
      </div>
    </>
  );
}
