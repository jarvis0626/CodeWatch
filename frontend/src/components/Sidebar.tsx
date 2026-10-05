import {
  Activity,
  ArrowUpRight,
  Boxes,
  FileCode2,
  FlaskConical,
  LayoutDashboard,
  Radio,
  Terminal,
} from 'lucide-react';
import { useState } from 'react';
import type { SessionInfo } from '../types/events';
import { PRODUCT_NAME, PRODUCT_VERSION } from '../config';

const links = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'architecture', label: 'Architecture', icon: Boxes },
  { id: 'files', label: 'File changes', icon: FileCode2 },
  { id: 'tests', label: 'Test results', icon: FlaskConical },
  { id: 'activity', label: 'Event stream', icon: Terminal },
];

export function Sidebar({ mode, session }: { mode: 'live' | 'demo'; session: SessionInfo | null }) {
  const [active, setActive] = useState('overview');
  return (
    <aside className="sidebar">
      <div className="sidebar-caption">WORKSPACE</div>
      <nav aria-label="Dashboard sections">
        {links.map(({ id, label, icon: Icon }) => (
          <a
            key={id}
            href={`#${id}`}
            className={`nav-link ${active === id ? 'selected' : ''}`}
            onClick={() => setActive(id)}
          >
            <Icon size={16} />
            {id === 'architecture' && mode === 'live' ? 'Project map' : label}
            {active === id && <span className="nav-indicator" />}
          </a>
        ))}
      </nav>
      <div className="sidebar-caption sessions-label">CURRENT SESSION</div>
      <a className="session-link" href="#architecture">
        <span className="session-icon">
          <Activity size={14} />
        </span>
        <span>
          {mode === 'demo' ? 'Todo application' : session?.projectName ?? 'No project connected'}<small>{mode === 'demo' ? 'Illustrative build' : session?.watching ? 'Filesystem observer active' : 'Connect a local folder'}</small>
        </span>
      </a>
      <div className="sidebar-bottom">
        <div className="local-card">
          <Radio size={17} />
          <strong>Your machine. Your build.</strong>
          <p>
            Every event, right here.
            <br />
            Any editor. Any AI.
          </p>
          <span>
            {mode === 'demo' ? 'LOCAL SIMULATOR' : 'LOCAL OBSERVER'} <span className="status-dot" />
          </span>
        </div>
        <a className="docs-link" href="http://localhost:8000/docs" target="_blank" rel="noreferrer">
          API documentation
          <ArrowUpRight size={13} />
        </a>
        <div className="sidebar-footer">
          {PRODUCT_NAME}<span>V{PRODUCT_VERSION}</span>
        </div>
      </div>
    </aside>
  );
}
