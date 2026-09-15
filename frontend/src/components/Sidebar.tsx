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

const links = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'architecture', label: 'Architecture', icon: Boxes },
  { id: 'files', label: 'File changes', icon: FileCode2 },
  { id: 'tests', label: 'Test results', icon: FlaskConical },
  { id: 'activity', label: 'Event stream', icon: Terminal },
];

export function Sidebar() {
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
            {label}
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
          Todo application<small>React + FastAPI + SQLite</small>
        </span>
      </a>
      <div className="sidebar-bottom">
        <div className="local-card">
          <Radio size={17} />
          <strong>Your machine. Your build.</strong>
          <p>
            Every event, right here.
            <br />
            No API keys required.
          </p>
          <span>
            LOCAL SIMULATOR <span className="status-dot" />
          </span>
        </div>
        <a className="docs-link" href="http://localhost:8000/docs" target="_blank" rel="noreferrer">
          API documentation
          <ArrowUpRight size={13} />
        </a>
        <div className="sidebar-footer">
          CodeWatch<span>V1.0</span>
        </div>
      </div>
    </aside>
  );
}
