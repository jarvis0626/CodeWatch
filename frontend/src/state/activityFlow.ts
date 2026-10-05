import type { BuildState } from './build';
import type { AgentEvent, CommandResult, FileChange, Stage, TestResult } from '../types/events';

export type ActivityStepStatus = 'active' | 'reported' | 'completed' | 'failed' | 'observed';
export interface ActivityFileChange extends FileChange {
  sequence: number;
  /** Filesystem timing is evidence of when a save happened, not who made it. */
  association: 'during-step' | 'observed-only';
}
export interface ActivityTestResult extends TestResult {
  eventId: string;
  timestamp: string;
  nodeId: string;
}
export interface ActivityCommandResult extends CommandResult {
  eventId: string;
  timestamp: string;
}
export interface ActivityStep {
  id: string;
  eventId: string;
  kind: 'report' | 'observed';
  stage: Stage | null;
  title: string;
  message: string;
  status: ActivityStepStatus;
  timestamp: string;
  sequence: number;
  endedAt: string | null;
  agentName: string | null;
  source: AgentEvent['source'];
  reportedPaths: string[];
  files: ActivityFileChange[];
  tests: ActivityTestResult[];
  commands: ActivityCommandResult[];
  events: AgentEvent[];
  completionMessage: string | null;
}
export interface ActivityFlow {
  steps: ActivityStep[];
  connections: { id: string; source: string; target: string }[];
  currentStepId: string | null;
  latestStepId: string | null;
}

const stageTitles: Record<Stage, string> = {
  PLANNING: 'Planning', EXPLORING: 'Exploring', IMPLEMENTING: 'Implementing',
  RUNNING: 'Running commands', TESTING: 'Testing', DEBUGGING: 'Debugging',
  VALIDATING: 'Validating', COMPLETE: 'Work reported complete',
};
type FlowInput = BuildState & { activityEvents?: AgentEvent[] };

function isReport(event: AgentEvent, demo: boolean) {
  return (event.type === 'agent_stage' || event.type === 'agent_message')
    && (demo || event.source === 'agent');
}
function isCompletion(event: AgentEvent, demo: boolean) {
  return event.type === 'build_complete' && (demo || event.source === 'agent');
}
function eventStep(event: AgentEvent, kind: ActivityStep['kind'], stage: Stage | null): ActivityStep {
  return {
    id: `activity:${event.runId}:${event.sequence}`, eventId: event.eventId,
    kind, stage, title: stage ? stageTitles[stage] : kind === 'report' ? 'Agent update' : 'Observed activity',
    message: event.data.message, status: kind === 'report' ? 'active' : 'observed',
    timestamp: event.timestamp, sequence: event.sequence, endedAt: null,
    agentName: event.agentName ?? null, source: event.source, reportedPaths: [],
    files: [], tests: [], commands: [], events: [], completionMessage: null,
  };
}

/**
 * Builds a sequence of actual reports, rather than assuming every predefined stage ran.
 * A connecting arrow means "reported next", not a dependency or a claim of success.
 */
export function activityFlow(state: FlowInput): ActivityFlow {
  const demo = state.mode === 'demo';
  const eventMap = new Map<number, AgentEvent>();
  for (const event of [...(state.activityEvents ?? []), ...state.events, ...(state.agentReport ? [state.agentReport] : [])]) {
    if (!state.runId || event.runId === state.runId) eventMap.set(event.sequence, event);
  }
  // Reconnect snapshots retain stage visits beyond the ordinary event feed.
  // Missing historical file/command details stay missing; they are never inferred.
  for (const visit of state.visits) {
    if (eventMap.has(visit.sequence) || (!demo && visit.source !== 'agent')) continue;
    eventMap.set(visit.sequence, {
      schemaVersion: 1, runId: state.runId ?? 'unknown', eventId: visit.eventId ?? `retained-stage:${visit.sequence}`,
      sequence: visit.sequence, timestamp: visit.timestamp,
      type: 'agent_stage', status: visit.status ?? (visit.stage === 'COMPLETE' ? 'completed' : 'running'),
      source: visit.source, agentName: visit.agentName,
      data: { stage: visit.stage, message: visit.message ?? stageTitles[visit.stage] },
    });
  }
  const events = [...eventMap.values()].sort((a, b) => a.sequence - b.sequence);
  const steps: ActivityStep[] = [];
  const nodePaths = new Map(state.nodes.filter((node) => node.path).map((node) => [node.id, node.path!]));
  const workingPaths = new Map<string, string>();
  const commandOwners = new Map<string, ActivityStep>();
  const testOwners = new Map<string, ActivityStep>();
  let active: ActivityStep | null = null;
  let observed: ActivityStep | null = null;
  let taskStart = 0;

  const pathFor = (nodeId: string) => nodePaths.get(nodeId)
    ?? (nodeId.startsWith('file:') ? nodeId.slice(5) : undefined);
  const evidenceStep = (event: AgentEvent) => {
    if (active) return active;
    if (!observed) {
      observed = eventStep(event, 'observed', null);
      steps.push(observed);
    }
    return observed;
  };
  const endActive = (event: AgentEvent, completed = false) => {
    if (!active) return;
    if (active.status === 'active') active.status = completed ? 'completed' : 'reported';
    active.endedAt = event.timestamp;
    if (completed) active.completionMessage = event.data.message;
    active = null;
  };
  const completeTask = (event: AgentEvent) => {
    // This is the agent's claim that the task is done. Test and command evidence
    // stays separate, including failures; completion never changes those results.
    for (const step of steps.slice(taskStart)) {
      if (step.kind !== 'report' || step.status === 'failed') continue;
      step.status = 'completed';
      step.endedAt ??= event.timestamp;
      step.completionMessage = event.data.message;
    }
  };

  for (const event of events) {
    if (event.type === 'graph_node_added' && event.data.path) nodePaths.set(event.data.id, event.data.path);
    if (event.type === 'graph_edge_added' && event.source === 'agent'
      && event.data.evidence === 'reported' && event.data.id.startsWith('working:')
      && event.data.source === 'agent') {
      const path = pathFor(event.data.target);
      if (path) workingPaths.set(event.data.id, path);
    }
    if (event.type === 'graph_edge_removed') workingPaths.delete(event.data.edgeId);

    if (isReport(event, demo)) {
      const stage = event.type === 'agent_stage' ? event.data.stage : null;
      const complete = stage === 'COMPLETE';
      const completedSuccessfully = complete && event.status !== 'failed';
      endActive(event, completedSuccessfully);
      if (completedSuccessfully) completeTask(event);
      observed = null;
      const step = eventStep(event, 'report', stage);
      step.reportedPaths = [...new Set(workingPaths.values())];
      step.events.push(event);
      if (complete) {
        step.status = event.status === 'failed' ? 'failed' : 'completed';
        step.endedAt = event.timestamp;
        step.completionMessage = event.data.message;
      } else if (event.status === 'failed') {
        step.status = 'failed';
      } else if (event.status === 'completed') {
        step.status = 'completed';
        step.endedAt = event.timestamp;
      }
      steps.push(step);
      // A failed report can still receive its subsequent diagnostic evidence.
      active = complete || step.status === 'completed' ? null : step;
      if (complete) taskStart = steps.length;
      continue;
    }

    if (isCompletion(event, demo)) {
      endActive(event, event.status !== 'failed');
      if (event.status !== 'failed') completeTask(event);
      observed = null;
      const latest = steps.at(-1);
      // The integration emits COMPLETE and build_complete together: one endpoint.
      const completion = latest?.stage === 'COMPLETE' && latest.kind === 'report'
        ? latest : eventStep(event, 'report', 'COMPLETE');
      if (completion !== latest) steps.push(completion);
      completion.status = event.status === 'failed' ? 'failed' : 'completed';
      completion.endedAt = event.timestamp;
      completion.completionMessage = event.data.message;
      completion.events.push(event);
      taskStart = steps.length;
      continue;
    }

    if (event.type === 'file_created' || event.type === 'file_modified' || event.type === 'file_deleted') {
      const step = evidenceStep(event);
      step.files.push({
        eventId: event.eventId, path: event.data.path,
        kind: event.type === 'file_created' ? 'created' : event.type === 'file_deleted' ? 'deleted' : 'modified',
        timestamp: event.timestamp, sequence: event.sequence, source: event.source,
        association: step.kind === 'report' ? 'during-step' : 'observed-only',
      });
      step.events.push(event);
      if (step.kind === 'observed') {
        step.title = event.source === 'agent' ? 'Reported file activity'
          : demo ? 'Simulated file activity' : 'Observed file activity';
        step.message = event.data.message;
      }
    } else if (event.type === 'test_started' || event.type === 'test_passed' || event.type === 'test_failed') {
      const key = `${event.data.name}:${event.data.attempt}`;
      const step = testOwners.get(key) ?? evidenceStep(event);
      testOwners.set(key, step);
      const result: ActivityTestResult = {
        name: event.data.name, attempt: event.data.attempt, details: event.data.details,
        status: event.type === 'test_started' ? 'running' : event.type === 'test_passed' ? 'passed' : 'failed',
        source: event.source, nodeId: event.data.nodeId, eventId: event.eventId, timestamp: event.timestamp,
      };
      const previous = step.tests.findIndex((test) => test.name === result.name && test.attempt === result.attempt);
      if (previous < 0) step.tests.push(result);
      else step.tests[previous] = result;
      step.events.push(event);
    } else if (event.type === 'command_started' || event.type === 'command_finished') {
      const step = commandOwners.get(event.data.commandId) ?? evidenceStep(event);
      commandOwners.set(event.data.commandId, step);
      const command: ActivityCommandResult = {
        id: event.data.commandId, command: event.data.command, output: event.data.output,
        exitCode: event.data.exitCode, status: event.status, source: event.source,
        eventId: event.eventId, timestamp: event.timestamp,
      };
      const previous = step.commands.findIndex((item) => item.id === command.id);
      if (previous < 0) step.commands.push(command);
      else step.commands[previous] = command;
      step.events.push(event);
    }
  }

  // The canonical snapshot can restore the latest reported paths even if the
  // working-edge events have left the feed. It says nothing about older steps.
  if (active) {
    for (const edge of state.edges) {
      if (edge.source !== 'agent' || !edge.id.startsWith('working:') || edge.evidence !== 'reported') continue;
      const path = pathFor(edge.target);
      if (path && !active.reportedPaths.includes(path)) active.reportedPaths.push(path);
    }
  }

  return {
    steps,
    connections: steps.slice(1).map((step, index) => ({
      id: `next:${steps[index].id}:${step.id}`, source: steps[index].id, target: step.id,
    })),
    currentStepId: active?.status === 'active' ? active.id : null,
    latestStepId: steps.at(-1)?.id ?? null,
  };
}
