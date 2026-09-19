import {
  ArrowUpRight,
  Braces,
  ChevronRight,
  Code2,
  FlaskConical,
  LoaderCircle,
  Play,
  RotateCcw,
  Terminal,
} from 'lucide-react';
import type { Connection } from '../state/build';
import { PRODUCT_NAME, PRODUCT_VERSION } from '../config';

interface Props {
  prompt: string;
  setPrompt: (prompt: string) => void;
  connection: Connection;
  start: () => void;
  reset: () => void;
}

export function Topbar({ connection }: { connection: Connection }) {
  return (
    <header className="topbar">
      <a className="brand" href="#overview" aria-label={`${PRODUCT_NAME} home`}>
        <span className="brand-mark">
          <Code2 size={21} />
        </span>
        {PRODUCT_NAME}
        <span className="version">v{PRODUCT_VERSION}</span>
      </a>
      <div className="topbar-divider" />
      <span className="workspace-name">Personal workspace</span>
      <div className="topbar-right">
        <span className={`connection ${connection}`}>
          <span className="status-dot" />
          {connection === 'streaming'
            ? 'Stream connected'
            : connection === 'connecting'
              ? 'Connecting'
              : connection === 'error'
                ? 'Disconnected'
                : 'Local environment'}
        </span>
        <span className="avatar">CW</span>
      </div>
    </header>
  );
}

export function BuildHeader({ prompt, setPrompt, connection, start, reset }: Props) {
  const running = connection === 'connecting' || connection === 'streaming';
  return (
    <section className="build-header" id="overview">
      <div className="breadcrumbs">
        <Braces size={14} />
        <span>Workspace</span>
        <ChevronRight size={13} />
        <span className="breadcrumb-current">todo-app</span>
      </div>
      <div className="page-heading">
        <div>
          <h1>Live workspace</h1>
          <p>A front-row seat to how your software takes shape.</p>
        </div>
        <span className="simulation-badge">
          <FlaskConical size={13} />
          Simulation mode
        </span>
      </div>
      <form
        className="prompt-bar"
        onSubmit={(event) => {
          event.preventDefault();
          if (!running) start();
        }}
      >
        <label htmlFor="build-prompt">
          <Terminal size={17} />
          <span className="sr-only">Build prompt</span>
        </label>
        <input
          id="build-prompt"
          maxLength={2000}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={running}
          spellCheck={false}
          placeholder="Describe what you want to build…"
        />
        <button className="button reset-button" type="button" onClick={reset}>
          <RotateCcw size={14} />
          <span>Reset</span>
        </button>
        <button className="button primary-button" type="submit" disabled={running}>
          {running ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Play size={14} fill="currentColor" />
          )}
          {running ? 'Building…' : 'Start Build'}
        </button>
      </form>
      <div className="prompt-note">
        <span>V1 demo · A predefined Todo build, from planning to passing tests.</span>
        <span className="duration-note">
          ~40 seconds
          <ArrowUpRight size={12} />
        </span>
      </div>
    </section>
  );
}
