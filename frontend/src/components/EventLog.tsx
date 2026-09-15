import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Download, Radio, Terminal } from 'lucide-react';
import type { AgentEvent, CommandResult } from '../types/events';
import { StatusIcon } from './StatusIcon';

const time = (timestamp: string) =>
  new Date(timestamp).toLocaleTimeString('en-GB', { hour12: false });

export function EventLog({
  events,
  commands,
  runId,
  live,
}: {
  events: AgentEvent[];
  commands: CommandResult[];
  runId: string | null;
  live: boolean;
}) {
  const [tab, setTab] = useState<'events' | 'commands'>('events');
  const [follow, setFollow] = useState(true);
  const feed = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [events.length, commands, follow, tab]);
  function download() {
    const url = URL.createObjectURL(
      new Blob([events.map((event) => JSON.stringify(event)).join('\n') + '\n'], {
        type: 'application/x-ndjson',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${runId ?? 'codewatch'}-events.ndjson`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="panel event-panel" id="activity" aria-label="Live event log">
      <header className="panel-header event-header">
        <div className="log-tabs" role="tablist" aria-label="Activity view">
          <button
            type="button"
            role="tab"
            id="events-tab"
            aria-controls="activity-content"
            aria-selected={tab === 'events'}
            className={tab === 'events' ? 'active' : ''}
            onClick={() => setTab('events')}
          >
            <Radio size={14} />
            Event stream<span className="count-badge">{events.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            id="commands-tab"
            aria-controls="activity-content"
            aria-selected={tab === 'commands'}
            className={tab === 'commands' ? 'active' : ''}
            onClick={() => setTab('commands')}
          >
            <Terminal size={14} />
            Commands<span className="count-badge">{commands.length}</span>
          </button>
        </div>
        <div className="log-actions">
          <button
            className={`follow-button ${follow ? 'following' : ''}`}
            aria-pressed={follow}
            onClick={() => setFollow(!follow)}
            title="Automatically follow new events"
          >
            <ArrowDown size={12} />
            <span>Auto-scroll</span>
          </button>
          <button
            className="icon-button"
            disabled={!events.length}
            onClick={download}
            title="Download event log"
            aria-label="Download event log"
          >
            <Download size={14} />
          </button>
        </div>
      </header>
      <div
        className="event-feed"
        ref={feed}
        role="tabpanel"
        id="activity-content"
        aria-labelledby={`${tab}-tab`}
        tabIndex={0}
      >
        {tab === 'events' ? (
          events.length ? (
            events.map((event) => (
              <div className={`event-row ${event.status}`} key={event.eventId}>
                <time dateTime={event.timestamp}>{time(event.timestamp)}</time>
                <span className="event-type">{event.type.replaceAll('_', '.')}</span>
                <span className="event-message">{event.data.message}</span>
                <StatusIcon status={event.status} size={12} animate={false} />
              </div>
            ))
          ) : (
            <div className="terminal-empty">
              <span className="terminal-prompt">$</span>
              <span>
                Waiting for your first build
                <span className="terminal-cursor" />
              </span>
              <small>Agent events will stream here in real time.</small>
            </div>
          )
        ) : commands.length ? (
          commands.map((command) => (
            <div className="command-entry" key={command.id}>
              <div>
                <span className="terminal-prompt">$</span>
                <code>{command.command}</code>
                <StatusIcon status={command.status} />
                <span className={`command-status ${command.status}`}>{command.status}</span>
              </div>
              {command.output && <pre>{command.output}</pre>}
            </div>
          ))
        ) : (
          <div className="terminal-empty">
            <span className="terminal-prompt">$</span>
            <span>No commands yet</span>
            <small>Simulated terminal commands appear during the build.</small>
          </div>
        )}
      </div>
      <footer className="event-footer">
        <span>
          <span className={`status-dot ${live ? 'live-dot' : ''}`} />
          {live ? 'Receiving events' : events.length ? 'End of stream' : 'Ready to connect'}
        </span>
        <span>
          {runId ? `${runId.slice(0, 16)}…` : 'No active run'}
          <span className="footer-separator">/</span>SIMULATED
        </span>
      </footer>
    </section>
  );
}
