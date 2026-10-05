import { describe, expect, it } from 'vitest';
import { agentEventSchema, type AgentEvent, type GraphNode } from '../types/events';
import { buildReducer, initialState, type BuildState } from './build';
import { activityFlow } from './activityFlow';

function event(sequence: number, type: string, data: object, extras: object = {}): AgentEvent {
  return agentEventSchema.parse({
    schemaVersion: 1, runId: 'run-1', eventId: `event-${sequence}`, sequence,
    timestamp: new Date(Date.UTC(2026, 9, 5, 10) + sequence * 1_000).toISOString(),
    source: 'agent', agentName: 'Coding assistant', status: 'running', type,
    data: { message: `Report ${sequence}`, ...data }, ...extras,
  });
}
const stage = (sequence: number, name = 'IMPLEMENTING', extras: object = {}) => event(sequence, 'agent_stage', { stage: name }, extras);
const file = (sequence: number, path: string, kind = 'modified') => event(sequence, `file_${kind}`, { path, nodeId: `file:${path}` }, { source: 'filesystem', status: 'completed' });
function stateFor(events: AgentEvent[]): BuildState {
  return [...events].sort((a, b) => a.sequence - b.sequence).reduce(
    (state, next) => buildReducer(state, { type: 'event', event: next }), initialState('live'),
  );
}
const node = (path: string): GraphNode => ({ id: `file:${path}`, path, label: path, kind: 'module', state: 'completed', message: 'Indexed on disk' });

describe('connected activity flow', () => {
  it('shows actual repeated reports in sequence without inventing stages or successful work', () => {
    const flow = activityFlow(stateFor([
      stage(1, 'EXPLORING'), stage(2), event(3, 'agent_message', { message: 'Connecting the form' }), stage(4),
    ]));
    expect(flow.steps.map((step) => [step.stage, step.status])).toEqual([
      ['EXPLORING', 'reported'], ['IMPLEMENTING', 'reported'], [null, 'reported'], ['IMPLEMENTING', 'active'],
    ]);
    expect(flow.connections.map((edge) => [edge.source, edge.target])).toEqual([
      [flow.steps[0].id, flow.steps[1].id], [flow.steps[1].id, flow.steps[2].id], [flow.steps[2].id, flow.steps[3].id],
    ]);
    expect(flow.currentStepId).toBe(flow.steps[3].id);
    expect(flow.steps.every((step) => step.tests.length === 0)).toBe(true);
  });

  it('uses explicit task completion for reported steps while preserving failed tests and failed reports', () => {
    const flow = activityFlow(stateFor([
      stage(1, 'EXPLORING'), stage(2, 'DEBUGGING', { status: 'failed' }), stage(3, 'TESTING'),
      event(4, 'test_failed', { name: 'Login', nodeId: 'tests', attempt: 1, details: 'Missing token' }, { status: 'failed' }),
      stage(5, 'COMPLETE'),
      event(6, 'build_complete', { filesTouched: 1, testsPassed: 0, testsTotal: 1, message: 'Task finished with known test failure' }, { status: 'completed' }),
    ]));
    expect(flow.steps.map((step) => step.status)).toEqual(['completed', 'failed', 'completed', 'completed']);
    expect(flow.steps[2].tests).toMatchObject([{ name: 'Login', status: 'failed', details: 'Missing token' }]);
    expect(flow.steps[0].completionMessage).toBe('Report 5');
    expect(flow.steps[3].completionMessage).toBe('Task finished with known test failure');
    expect(flow.currentStepId).toBeNull();
    expect(flow.steps[3].events.map((item) => item.type)).toEqual(['agent_stage', 'build_complete']);
  });

  it('keeps a new task active after completion and puts intervening saves in observed activity', () => {
    const flow = activityFlow(stateFor([
      stage(1), file(2, 'src/a.ts'),
      event(3, 'build_complete', { filesTouched: 1, testsPassed: 0, testsTotal: 0 }, { status: 'completed' }),
      file(4, 'src/a.ts'), stage(5, 'EXPLORING'), file(6, 'src/b.ts', 'created'),
    ]));
    expect(flow.steps.map((step) => [step.kind, step.status])).toEqual([
      ['report', 'completed'], ['report', 'completed'], ['observed', 'observed'], ['report', 'active'],
    ]);
    expect(flow.steps[0].files.map((change) => change.eventId)).toEqual(['event-2']);
    expect(flow.steps[2].files).toMatchObject([{ eventId: 'event-4', association: 'observed-only' }]);
    expect(flow.steps[3].files).toMatchObject([{ eventId: 'event-6', association: 'during-step' }]);
    expect(flow.currentStepId).toBe(flow.steps[3].id);
  });

  it('associates file changes by sequence even when timestamps match, without claiming authorship', () => {
    const timestamp = '2026-10-05T10:00:00Z';
    const events = [stage(1), file(2, 'src/a.ts'), stage(3, 'VALIDATING'), file(4, 'src/a.ts', 'deleted')]
      .map((item) => ({ ...item, timestamp }));
    const state = stateFor(events);
    const flow = activityFlow({ ...state, events: [...events].reverse() });
    expect(flow.steps[0].files).toMatchObject([{ kind: 'modified', sequence: 2, source: 'filesystem', association: 'during-step' }]);
    expect(flow.steps[1].files).toMatchObject([{ kind: 'deleted', sequence: 4, source: 'filesystem', association: 'during-step' }]);
    expect(flow.steps[0].files[0].path).toBe('src/a.ts');
    expect(flow.steps[0].reportedPaths).toEqual([]);
  });

  it('shows observed saves without treating indexed nodes or system messages as completed agent work', () => {
    const state = stateFor([
      event(1, 'agent_message', { message: 'Watcher started' }, { source: 'system', status: 'completed' }),
      stage(2, 'COMPLETE', { source: 'system', status: 'completed' }),
      file(3, 'main.py', 'created'), file(4, 'main.py'),
    ]);
    state.nodes = [node('main.py')];
    const flow = activityFlow(state);
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0]).toMatchObject({ kind: 'observed', status: 'observed', stage: null, title: 'Observed file activity' });
    expect(flow.steps[0].files.map((change) => change.kind)).toEqual(['created', 'modified']);
    expect(flow.currentStepId).toBeNull();
    expect(flow.latestStepId).toBe(flow.steps[0].id);
  });

  it('keeps command and test outcomes with their invocation step across stage transitions and retries', () => {
    const flow = activityFlow(stateFor([
      stage(1, 'TESTING'),
      event(2, 'command_started', { commandId: 'pytest-1', command: 'pytest' }, { source: 'command' }),
      event(3, 'test_started', { name: 'Login', nodeId: 'tests', attempt: 1 }),
      stage(4, 'VALIDATING'),
      event(5, 'command_finished', { commandId: 'pytest-1', command: 'pytest', output: 'Failed login', exitCode: 1 }, { source: 'command', status: 'failed' }),
      event(6, 'test_failed', { name: 'Login', nodeId: 'tests', attempt: 1 }, { status: 'failed' }),
      event(7, 'test_started', { name: 'Login', nodeId: 'tests', attempt: 2 }),
      event(8, 'test_passed', { name: 'Login', nodeId: 'tests', attempt: 2 }, { status: 'completed' }),
    ]));
    expect(flow.steps[0].commands).toMatchObject([{ id: 'pytest-1', status: 'failed', exitCode: 1, source: 'command' }]);
    expect(flow.steps[0].tests).toMatchObject([{ name: 'Login', attempt: 1, status: 'failed' }]);
    expect(flow.steps[1].tests).toMatchObject([{ name: 'Login', attempt: 2, status: 'passed' }]);
    expect(flow.steps[1].status).toBe('active');
    expect(flow.steps[1].commands).toEqual([]);
    expect(flow.steps[0].events.map((item) => item.sequence)).toEqual([1, 2, 3, 5, 6]);
  });

  it('recovers declared work paths from working edges emitted before the progress report', () => {
    const working = (sequence: number, path: string) => event(sequence, 'graph_edge_added', {
      id: `working:file:${path}`, source: 'agent', target: `file:${path}`, label: 'working on', evidence: 'reported',
    });
    const state = stateFor([
      working(1, 'src/a.ts'), stage(2),
      event(3, 'graph_edge_removed', { edgeId: 'working:file:src/a.ts' }),
      working(4, 'src/b.ts'), stage(5, 'VALIDATING'),
    ]);
    const flow = activityFlow(state);
    expect(flow.steps.map((step) => step.reportedPaths)).toEqual([['src/a.ts'], ['src/b.ts']]);
    expect(flow.steps.every((step) => step.files.length === 0)).toBe(true);
  });

  it('restores retained stages and canonical current paths without inventing missing historical evidence', () => {
    const old = stage(1, 'EXPLORING');
    const current = stage(800, 'IMPLEMENTING');
    const latest = file(801, 'src/a.ts');
    const state: BuildState & { activityEvents: AgentEvent[] } = {
      ...initialState('live'), runId: 'run-1', events: [latest], activityEvents: [],
      visits: [old, current].map((item) => ({
        stage: item.type === 'agent_stage' ? item.data.stage : 'EXPLORING',
        source: item.source, message: item.data.message, timestamp: item.timestamp, sequence: item.sequence,
      })),
      nodes: [node('src/a.ts')],
      edges: [{ id: 'working:file:src/a.ts', source: 'agent', target: 'file:src/a.ts', evidence: 'reported', label: 'working on', message: 'Declared work' }],
    };
    const flow = activityFlow(state);
    expect(flow.steps.map((step) => step.stage)).toEqual(['EXPLORING', 'IMPLEMENTING']);
    expect(flow.steps[0].files).toEqual([]);
    expect(flow.steps[0].commands).toEqual([]);
    expect(flow.steps[0].reportedPaths).toEqual([]);
    expect(flow.steps[1].reportedPaths).toEqual(['src/a.ts']);
    expect(flow.steps[1].files).toHaveLength(1);
    expect(activityFlow({ ...state, events: [old, current, latest] }).steps.map((step) => step.id))
      .toEqual(flow.steps.map((step) => step.id));
  });

  it('uses retained activity details once and ignores stale cross-project events', () => {
    const progress = stage(1, 'TESTING');
    const passed = event(2, 'test_passed', { name: 'Login', nodeId: 'tests', attempt: 1 }, { status: 'completed' });
    const change = file(800, 'src/a.ts');
    const state = { ...stateFor([progress, passed, change]), events: [change], activityEvents: [progress, passed, change, stage(900, 'COMPLETE', { runId: 'old-run' })] };
    const flow = activityFlow(state);
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0].tests).toHaveLength(1);
    expect(flow.steps[0].files).toHaveLength(1);
    expect(flow.steps[0].status).toBe('active');
    expect(flow.steps[0].events.map((item) => item.eventId)).toEqual(['event-1', 'event-2', 'event-800']);
  });

  it('preserves failed stage outcomes after substantive activity rolls over and the agent completes the task', () => {
    const failed = stage(1, 'DEBUGGING', { status: 'failed', agentName: 'First assistant' });
    const events = [failed, stage(2, 'TESTING'), ...Array.from({ length: 2005 }, (_, index) => file(index + 3, 'src/a.ts')), stage(2008, 'COMPLETE')];
    const state = stateFor(events);
    expect(state.activityEvents.some(item => item.eventId === failed.eventId)).toBe(false);
    const flow = activityFlow(state);
    expect(flow.steps[0]).toMatchObject({
      stage: 'DEBUGGING', status: 'failed', eventId: failed.eventId, agentName: 'First assistant',
    });
    expect(flow.steps.filter(step => step.kind === 'report').map(step => step.status)).toEqual(['failed', 'completed', 'completed']);
    expect(flow.currentStepId).toBeNull();
  });

  it('includes the canonical latest agent message when it is newer than the retained stage and outside the feed', () => {
    const exploration = stage(1, 'EXPLORING');
    const update = event(2, 'agent_message', { message: 'Connecting the login form' });
    const saved = file(2050, 'src/a.ts');
    const state = { ...stateFor([exploration, update, saved]), activityEvents: [saved], events: [saved] };
    const flow = activityFlow(state);
    expect(flow.steps.map(step => step.message)).toEqual(['Report 1', 'Connecting the login form']);
    expect(flow.steps[1].status).toBe('active');
    expect(flow.steps[1].files.map(change => change.eventId)).toEqual(['event-2050']);
    const stale = activityFlow({ ...state, agentReport: { ...update, runId: 'another-project' } });
    expect(stale.steps).toHaveLength(1);
    expect(stale.steps[0].stage).toBe('EXPLORING');
  });
});
