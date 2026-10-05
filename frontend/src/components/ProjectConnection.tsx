import { useEffect, useState } from 'react';
import { Braces, Check, ChevronRight, Copy, FolderOpen, LoaderCircle, Plug, Radio, Square, Terminal } from 'lucide-react';
import type { SessionInfo } from '../types/events';
import { apiRequest } from '../hooks/useLiveEvents';
import type {} from '../types/desktop';

interface Props {
  session: SessionInfo | null;
  busy: boolean;
  watch: (path: string, agent: string) => void;
  stop: () => void;
}
export function ProjectConnection({ session, busy, watch, stop }: Props) {
  const [path, setPath] = useState('');
  const [agent, setAgent] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [folderError, setFolderError] = useState('');
  const disabled = busy || choosing;
  useEffect(() => { if (session) { setPath(session.projectPath); setAgent(session.agentName ?? ''); } }, [session?.runId]);
  async function chooseFolder() {
    if (!window.codewatchDesktop || disabled) return;
    setChoosing(true);
    setFolderError('');
    try {
      const folder = await window.codewatchDesktop.chooseFolder();
      if (folder) {
        setPath(folder);
        await watch(folder, agent);
      }
    } catch {
      setFolderError('Could not open this project folder. Please try again or enter its path.');
    } finally {
      setChoosing(false);
    }
  }
  return <section className="build-header" id="overview">
    <div className="breadcrumbs"><Braces size={14} /><span>Workspace</span><ChevronRight size={13} /><span className="breadcrumb-current">{session?.projectName ?? 'Connect a project'}</span></div>
    <div className="page-heading"><div><h1>Your code. The whole picture.</h1><p>Follow real changes, see the connections, and understand what your AI is building.</p></div><span className="simulation-badge real-badge"><Radio size={13} />{session?.watching ? 'Watching project' : 'Live project'}</span></div>
    <form className="project-connect-form" onSubmit={(event) => { event.preventDefault(); if (!disabled && path.trim()) { setFolderError(''); watch(path.trim(), agent); } }}>
      <div className="prompt-bar project-path"><label htmlFor="project-path"><FolderOpen size={17} /><span className="sr-only">Project folder</span></label><input id="project-path" value={path} onChange={(event) => setPath(event.target.value)} spellCheck={false} placeholder="Absolute project folder, e.g. D:\Projects\my-app" required disabled={disabled} />
        {window.codewatchDesktop && <button className="button native-folder-button" type="button" onClick={() => void chooseFolder()} disabled={disabled}><FolderOpen size={14} />Choose folder</button>}
        {session?.watching && <button className="button reset-button" type="button" onClick={stop} disabled={disabled}><Square size={12} /><span>Stop watching</span></button>}
        <button className="button primary-button" type="submit" disabled={disabled || !path.trim()}>{disabled ? <LoaderCircle className="spin" size={14} /> : <Radio size={14} />}Watch project</button>
      </div>
      <div className="project-options"><label htmlFor="agent-label">Session label <span>(optional)</span></label><input id="agent-label" value={agent} onChange={(event) => setAgent(event.target.value)} placeholder="e.g. Antigravity, Codex, Cursor" maxLength={100} disabled={disabled} /><span>A label for you. File changes do not identify which tool made them.</span></div>
      {folderError && <p className="inline-error" role="alert">{folderError}</p>}
    </form>
    <div className="prompt-note"><span>Choose the same local folder your IDE uses. Connect its AI below to show reported plans and progress.</span><span>{session ? `${session.trackedFiles} tracked files` : 'Local · No API keys'}</span></div>
    {session?.warnings.map((warning, index) => <div className="notice project-warning" key={index}>{warning}</div>)}
  </section>;
}

interface IntegrationInfo { mcpConfig: object; codexConfig: string; instructions: string; endpoint: string }
export function IntegrationPanel() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'mcp' | 'watcher'>('mcp');
  const [format, setFormat] = useState<'json' | 'codex' | 'instructions'>('json');
  const [info, setInfo] = useState<IntegrationInfo | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open || info) return;
    let active = true;
    apiRequest('/api/integrations').then((data: IntegrationInfo) => { if (active) { setInfo(data); setError(''); } }).catch((failure: Error) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [open, info]);
  const snippet = !info ? '' : format === 'json' ? JSON.stringify(info.mcpConfig, null, 2) : format === 'codex' ? info.codexConfig : info.instructions;
  async function copy() {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copy is unavailable here. Select the text below to copy it.'); }
  }
  return <section className={`panel integration-panel ${open ? 'is-open' : ''}`} id="connect">
    <button className="integration-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="integration-content"><span className="integration-icon"><Plug size={18} /></span><span><strong>Connect your AI</strong><small>Give the activity a story: plans, current steps, and how the pieces fit together.</small></span><span className="setup-label">{open ? 'Close setup' : 'Set up integration'}<ChevronRight size={14} /></span></button>
    {open && <div id="integration-content" className="integration-content">
      <div className="mode-switch integration-tabs" role="tablist" aria-label="Integration method"><button role="tab" aria-selected={tab === 'mcp'} onClick={() => setTab('mcp')} className={tab === 'mcp' ? 'active' : ''}><Plug size={13} />AI progress via MCP</button><button role="tab" aria-selected={tab === 'watcher'} onClick={() => setTab('watcher')} className={tab === 'watcher' ? 'active' : ''}><FolderOpen size={13} />Any IDE: file watcher</button></div>
      {tab === 'mcp' ? <div className="integration-layout"><div className="integration-explanation"><h3>Your AI tells CodeWatch what it is doing.</h3><p>MCP is a standard for connecting tools to AI assistants. Add this local server to an IDE or coding assistant that supports MCP, then give your agent the project instructions.</p><ol><li>Watch your project folder above.</li><li>Add the server in your assistant's MCP settings and reload the tools.</li><li>Copy the agent instructions into your project or current chat.</li></ol><p>Reported stages and connections are labeled <strong>Agent-reported</strong>. The watcher still observes file changes independently.</p><p className="integration-limit">ChatGPT in a browser cannot directly watch your local files. Use a local coding integration, such as Codex with MCP, to report progress here. Each IDE's MCP support and configuration may differ.</p></div><div className="integration-code"><div className="snippet-toolbar"><label className="sr-only" htmlFor="config-format">Configuration format</label><select id="config-format" value={format} onChange={(event) => { setFormat(event.target.value as typeof format); setCopied(false); }}><option value="json">MCP JSON configuration</option><option value="codex">Codex TOML configuration</option><option value="instructions">Agent instructions</option></select><button className="button reset-button" onClick={copy} disabled={!snippet}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}</button></div>{error && <p className="inline-error" role="alert">{error}</p>}<pre tabIndex={0}>{snippet || (error ? 'Start the backend, then reopen setup to retry.' : 'Loading configuration…')}</pre>{info && <small><Terminal size={11} />Local bridge: {info.endpoint}</small>}</div></div> : <div className="watcher-guide"><h3>Works alongside any editor that changes local files.</h3><p>Open your project in your IDE, enter the same folder above, and work normally. CodeWatch observes created, edited, and deleted source files and maps supported local imports.</p><div className="capability-grid"><div><strong>Visible from the filesystem</strong><p>File activity, discovered modules, and supported import relationships. This includes edits from you, scripts, and AI tools.</p></div><div><strong>Needs an agent integration</strong><p>The plan, the reason behind a change, current task, runtime flow, and test results. These appear when the assistant reports them through MCP or the event API.</p></div></div><p className="integration-limit">An import shows a code dependency. It does not prove the runtime request path. Dashed connections indicate a flow reported by your agent.</p></div>}
    </div>}
  </section>;
}
