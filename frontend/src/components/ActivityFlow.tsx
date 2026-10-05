import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Bot, Check, ChevronDown, Circle, FileCode2, GitBranch, LocateFixed, Terminal, TriangleAlert } from 'lucide-react';
import { activityFlow, type ActivityStep } from '../state/activityFlow';
import type { BuildState } from '../state/build';
import { sourceLabel } from '../types/events';

interface ActivityFlowProps {
  state: BuildState;
  compact?: boolean;
  onSelectFile?: (path: string) => void;
}

const statusLabels = {
  active: 'Current', reported: 'Earlier report', completed: 'Done (reported)', failed: 'Failed', observed: 'Observed only',
};

function fileName(path: string) { return path.replaceAll('\\', '/').split('/').at(-1) || path; }
function shortTime(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function FileLink({ path, label = path, onSelectFile }: { path: string; label?: string; onSelectFile?: (path: string) => void }) {
  return onSelectFile
    ? <button className="flow-file-link" type="button" title={`Open ${path} in project map`} onClick={() => onSelectFile(path)}><FileCode2 size={13} /><code>{label}</code></button>
    : <span className="flow-file-link" title={path}><FileCode2 size={13} /><code>{label}</code></span>;
}

function StepDetails({ step, state, onSelectFile, onClose }: {
  step: ActivityStep; state: BuildState; onSelectFile?: (path: string) => void; onClose: () => void;
}) {
  const paths = new Set([...step.reportedPaths, ...step.files.map(file => file.path)]);
  const nodes = new Map(state.nodes.map(node => [node.id, node]));
  const links = state.edges.flatMap(edge => {
    const source = nodes.get(edge.source)?.path;
    const target = nodes.get(edge.target)?.path;
    return source && target && (edge.evidence === 'import' || edge.evidence === 'reported') && (paths.has(source) || paths.has(target))
      ? [{ ...edge, sourcePath: source, targetPath: target }] : [];
  });
  return (
    <div className="flow-step-details" data-testid="flow-step-details">
      <div className="flow-details-heading"><strong>{step.title}</strong><button type="button" className="flow-text-button" onClick={onClose}>Close details</button></div>
      <p className="flow-detail-report">{step.message}</p>
      <div className="flow-details-meta"><span>{sourceLabel(step.source, state.mode === 'demo')}</span><time dateTime={step.timestamp}>{shortTime(step.timestamp)}</time></div>
      {step.completionMessage && step.completionMessage !== step.message && <p className="flow-completion"><Check size={13} />{step.completionMessage}</p>}
      <div className="flow-details-sections">
        <section><h3>Reported files</h3>{step.reportedPaths.length > 0 ? <div className="flow-file-list">{step.reportedPaths.map(path => <FileLink key={path} path={path} onSelectFile={onSelectFile} />)}</div> : <p className="flow-no-evidence">No file paths reported for this step.</p>}</section>
        <section><h3>{step.kind === 'report' ? 'File changes during this step' : 'File activity'}</h3>
          {step.files.length > 0 ? <ul className="flow-evidence-list">{step.files.map(file => <li key={file.eventId}><FileLink path={file.path} onSelectFile={onSelectFile} /><span className={`flow-change-kind flow-change-${file.kind}`}>{file.kind}</span><small>{sourceLabel(file.source, state.mode === 'demo')}</small></li>)}</ul> : <p className="flow-no-evidence">No file changes recorded.</p>}
          {step.kind === 'report' && step.files.some(file => file.source === 'filesystem') && <p className="flow-evidence-note">A save during a step shows timing; it does not identify who made it.</p>}
        </section>
        {(step.tests.length > 0 || step.commands.length > 0) && <section className="flow-outcomes"><h3>Tests and commands</h3>
          <ul className="flow-evidence-list">{step.tests.map(test => <li key={`${test.name}:${test.attempt}`} className={`flow-outcome flow-outcome-${test.status}`}><span className="flow-outcome-line"><span className="flow-outcome-label">{test.status === 'passed' ? 'Passed' : test.status === 'failed' ? 'Failed' : 'Running'}</span><code>{test.name}</code><small>Attempt {test.attempt}</small></span>{test.details && <pre>{test.details}</pre>}<small>{sourceLabel(test.source, state.mode === 'demo')}</small></li>)}
            {step.commands.map(command => <li key={command.id} className={`flow-outcome flow-outcome-${command.status}`}><span className="flow-outcome-line"><Terminal size={13} /><code>{command.command}</code><span className="flow-outcome-label">{command.status === 'completed' ? 'Done' : command.status === 'failed' ? 'Failed' : command.status === 'running' ? 'Running' : 'Pending'}</span></span>{command.exitCode != null && <small>Exit code {command.exitCode}</small>}{command.output && <pre>{command.output}</pre>}<small>{sourceLabel(command.source, state.mode === 'demo')}</small></li>)}</ul>
        </section>}
        {links.length > 0 && <section className="flow-dependencies"><h3><GitBranch size={13} />File connections</h3><p className="flow-evidence-note">Connections in the current project map.</p><ul className="flow-dependency-list">{links.map(link => <li key={link.id}><FileLink path={link.sourcePath} onSelectFile={onSelectFile} /><ArrowRight size={16} aria-label="connects to" /><FileLink path={link.targetPath} onSelectFile={onSelectFile} /><small>{link.evidence === 'import' ? 'Import' : 'Agent-reported'} · {link.label}</small></li>)}</ul></section>}
      </div>
    </div>
  );
}

export function ActivityFlow({ state, compact = false, onSelectFile }: ActivityFlowProps) {
  const flow = useMemo(() => activityFlow(state), [state]);
  const [followCurrent, setFollowCurrent] = useState(true);
  const [selection, setSelection] = useState<{ runId: string | null; id: string } | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const track = useRef<HTMLOListElement>(null);
  const stepElements = useRef(new Map<string, HTMLLIElement>());
  const latestId = flow.currentStepId ?? flow.latestStepId;
  const selectedId = followCurrent || selection?.runId !== state.runId ? latestId : selection.id;
  const selectedStep = flow.steps.find(step => step.id === selectedId) ?? flow.steps.at(-1);
  const latestReport = [...flow.steps].reverse().find(step => step.kind === 'report');
  const observedFile = state.files.find(file => state.mode === 'demo' || file.source === 'filesystem');
  const activeStep = flow.steps.find(step => step.id === flow.currentStepId);
  const workingPaths = activeStep?.reportedPaths ?? [];
  const workingPath = workingPaths[0];
  const streamStatus = state.connection === 'connecting' ? 'Connecting'
    : state.connection === 'error' ? 'Disconnected'
      : state.session?.watching || (state.mode === 'demo' && state.connection === 'streaming') ? 'Watching' : 'Stopped';
  const hasReports = flow.steps.some(step => step.kind === 'report');
  const selectedForRun = selection?.runId === state.runId;
  const showDetails = detailsOpen && (followCurrent || selectedForRun) && !!selectedStep;

  useEffect(() => {
    if (!followCurrent || !selectedId) return;
    const container = track.current;
    const item = stepElements.current.get(selectedId);
    if (!container || !item) return;
    if (compact) {
      if (item.offsetTop < container.scrollTop || item.offsetTop + item.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = item.offsetTop;
    } else if (item.offsetLeft < container.scrollLeft || item.offsetLeft + item.offsetWidth > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = Math.max(0, item.offsetLeft + item.offsetWidth - container.clientWidth);
    }
  }, [selectedId, followCurrent, compact]);

  function selectStep(step: ActivityStep) {
    setSelection({ runId: state.runId, id: step.id }); setFollowCurrent(false); setDetailsOpen(true);
  }
  function toggleFollow() {
    if (followCurrent && selectedStep) setSelection({ runId: state.runId, id: selectedStep.id });
    setFollowCurrent(!followCurrent);
  }
  const details = selectedStep && <StepDetails step={selectedStep} state={state} onSelectFile={onSelectFile} onClose={() => setDetailsOpen(false)} />;
  return (
    <section id="work-flow" className={`panel activity-flow ${compact ? 'activity-flow-compact' : ''}`} aria-label="Work flow" data-testid="activity-flow">
      <header className="flow-header"><div><h2><GitBranch size={16} />Work flow</h2><p>Arrows show the order of reported steps.</p></div><div className="flow-header-actions"><span className={`flow-stream-badge flow-stream-${streamStatus.toLowerCase()}`}><span />{streamStatus}</span><button className={`flow-follow ${followCurrent ? 'is-following' : ''}`} type="button" aria-pressed={followCurrent} onClick={toggleFollow} disabled={!flow.steps.length}><LocateFixed size={13} /><span>Follow current</span></button></div></header>
      <div className="flow-current-context">
        <div className="flow-current-report" data-testid="flow-current-report"><span className="flow-context-label"><Bot size={13} />{state.mode === 'demo' ? 'Latest simulated report' : 'Latest agent report'}</span><p>{latestReport?.message ?? (state.agentReport?.data.message || 'Waiting for the agent to report its next step.')}</p>{latestReport && <small>{latestReport.title}{latestReport.agentName ? ` · ${latestReport.agentName}` : ''}</small>}</div>
        <div className="flow-current-file" data-testid="flow-current-file"><span className="flow-context-label"><FileCode2 size={13} />{workingPath ? 'Working on' : state.mode === 'demo' ? 'Latest simulated file' : 'Latest saved file'}</span>
          {workingPath ? <><FileLink path={workingPath} label={compact ? fileName(workingPath) : workingPath} onSelectFile={onSelectFile} /><small className="flow-file-source">Agent-reported{workingPaths.length > 1 ? ` · +${workingPaths.length - 1} more ${workingPaths.length === 2 ? 'file' : 'files'}` : ''}</small>{observedFile && observedFile.path !== workingPath && <div className="flow-secondary-file"><span>Latest saved · {state.mode === 'demo' ? 'Simulated' : 'Observed'}</span><FileLink path={observedFile.path} label={fileName(observedFile.path)} onSelectFile={onSelectFile} /></div>}</>
            : observedFile ? <><FileLink path={observedFile.path} label={compact ? fileName(observedFile.path) : observedFile.path} onSelectFile={onSelectFile} /><small className="flow-file-source">{state.mode === 'demo' ? 'Simulated' : 'Observed'} · {observedFile.kind}</small></> : <p>Waiting for a file change.</p>}
        </div>
      </div>
      {!hasReports && <div className="flow-awaiting"><Bot size={16} /><p>{flow.steps.length ? 'File activity is visible. The agent has not reported a work step yet.' : 'Connect a project and add the agent integration to see connected work steps.'}</p></div>}
      {flow.steps.length > 0 && <ol className="flow-track" ref={track} aria-label="Ordered work steps">{flow.steps.map((step, index) => {
        const selected = step.id === selectedStep?.id;
        const fileCount = new Set([...step.reportedPaths, ...step.files.map(file => file.path)]).size;
        const failedEvidence = step.tests.filter(test => test.status === 'failed').length + step.commands.filter(command => command.status === 'failed').length;
        return <li key={step.id} className={`flow-node-wrapper ${selected ? 'is-selected' : ''}`} ref={element => { if (element) stepElements.current.set(step.id, element); else stepElements.current.delete(step.id); }}>
          <button className={`flow-step flow-step-${step.status} ${selected ? 'is-selected' : ''}`} type="button" data-testid={`flow-step-${step.id}`} aria-expanded={showDetails && selected} aria-label={`${index + 1}. ${step.title}: ${statusLabels[step.status]}. ${step.message}`} onClick={() => selectStep(step)}>
            <span className="flow-step-top"><span className="flow-step-number">{String(index + 1).padStart(2, '0')}</span><span className={`flow-step-status flow-status-${step.status}`}>{step.status === 'completed' ? <Check size={12} /> : step.status === 'failed' ? <TriangleAlert size={12} /> : step.status === 'active' ? <span className="flow-active-dot" /> : <Circle size={9} />}{statusLabels[step.status]}</span></span>
            <strong className="flow-step-title">{step.title}</strong><span className="flow-step-message">{step.message}</span>
            <span className="flow-step-bottom"><time dateTime={step.timestamp}>{shortTime(step.timestamp)}</time><span>{fileCount > 0 ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'}` : step.kind === 'report' ? 'Agent-reported' : 'File activity'}</span><ChevronDown size={13} /></span>
            {failedEvidence > 0 && <span className="flow-failed-evidence"><TriangleAlert size={11} />{failedEvidence} failed {failedEvidence === 1 ? 'check' : 'checks'}</span>}
          </button>
          {compact && showDetails && selected && details}
          {index < flow.steps.length - 1 && <span className="flow-connector" data-testid="flow-connector" aria-hidden="true"><ArrowRight size={26} /></span>}
        </li>;
      })}</ol>}
      {!compact && showDetails && details}
    </section>
  );
}
