import { describe, expect, it } from 'vitest';
import { agentEventSchema, liveFrameSchema, type SessionInfo } from '../types/events';
import { buildReducer, initialState } from './build';
import type { BuildState } from './build';

const running = () => buildReducer(initialState(), { type: 'start', now: 1 });
function receive(state: BuildState, type: string, data: object, extras: object = {}) {
  const sequence = state.events.length + 1;
  const event = agentEventSchema.parse({
    schemaVersion: 1,
    runId: 'run-1',
    eventId: `event-${sequence}`,
    sequence,
    timestamp: '2026-09-15T12:00:00Z',
    status: 'running',
    type,
    data: { message: 'Event', ...data },
    ...extras,
  });
  return buildReducer(state, { type: 'event', event });
}

describe('build event consumer', () => {
  it('restores step evidence after scan updates evict it from the visible event ring', () => {
    const report = agentEventSchema.parse({ schemaVersion: 1, runId: 'run-1', eventId: 'report-1', sequence: 1,
      timestamp: '2026-09-15T12:00:00Z', status: 'running', source: 'agent', type: 'agent_stage',
      data: { stage: 'IMPLEMENTING', message: 'Add a handler' } });
    const save = agentEventSchema.parse({ schemaVersion: 1, runId: 'run-1', eventId: 'save-2', sequence: 2,
      timestamp: '2026-09-15T12:00:01Z', status: 'completed', source: 'filesystem', type: 'file_modified',
      data: { path: 'main.py', nodeId: 'file:main.py', message: 'Saved handler' } });
    const scan = agentEventSchema.parse({ schemaVersion: 1, runId: 'run-1', eventId: 'scan-650', sequence: 650,
      timestamp: '2026-09-15T12:01:00Z', status: 'completed', source: 'filesystem', type: 'graph_node_updated',
      data: { nodeId: 'file:main.py', state: 'completed', message: 'Indexed file' } });
    const frame = liveFrameSchema.parse({ kind: 'snapshot', session, events: [scan], activityEvents: [report, save],
      graph: { nodes: [], edges: [] } });
    if (frame.kind !== 'snapshot') throw new Error('Expected snapshot');
    const restored = buildReducer(initialState('live'), { type: 'snapshot', ...frame });
    expect(restored.events).toEqual([scan]);
    expect(restored.activityEvents.map((event) => event.eventId)).toEqual(['report-1', 'save-2']);
    expect(restored.files[0].path).toBe('main.py');
    expect(restored.stage).toBe('IMPLEMENTING');
    expect(buildReducer(restored, { type: 'session', session: { ...session, runId: 'another-run' } }).activityEvents).toEqual([]);
  });
  it('rejects mismatched and unsupported payloads at the boundary', () => {
    expect(() => receive(running(), 'file_created', { nodeId: 'api' })).toThrow();
    expect(() => receive(running(), 'agent_stage', { stage: 'UNKNOWN' })).toThrow();
  });
  it('ignores stale, duplicate, and cross-run events', () => {
    const state = receive(running(), 'agent_stage', { stage: 'PLANNING' });
    expect(buildReducer(state, { type: 'event', event: state.events[0] })).toBe(state);
    expect(receive(state, 'agent_stage', { stage: 'COMPLETE' }, { runId: 'old-run' })).toBe(state);
    expect(receive(state, 'agent_stage', { stage: 'COMPLETE' }, { sequence: 1 })).toBe(state);
  });
  it('resets every panel and ignores late events after reset', () => {
    let state = receive(running(), 'file_created', { path: 'main.py', nodeId: 'api' });
    state = receive(state, 'test_failed', { name: 'test_create', nodeId: 'tests', attempt: 1 });
    const reset = buildReducer(state, { type: 'reset' });
    expect(reset).toEqual(initialState());
    expect(buildReducer(reset, { type: 'event', event: state.events[0] })).toBe(reset);
  });
  it('keeps file history while allowing unique file statistics', () => {
    const created = receive(running(), 'file_created', { path: 'main.py', nodeId: 'api' });
    const modified = receive(created, 'file_modified', { path: 'main.py', nodeId: 'api' });
    expect(modified.files.map((file) => file.kind)).toEqual(['modified', 'created']);
    expect(new Set(modified.files.map((file) => file.path)).size).toBe(1);
  });
  it('preserves a failure until that test starts a new attempt', () => {
    let state = receive(
      running(),
      'test_failed',
      { name: 'test_create', nodeId: 'tests', attempt: 1, details: 'Missing ID' },
      { status: 'failed' },
    );
    state = receive(
      state,
      'test_passed',
      { name: 'test_list', nodeId: 'tests', attempt: 1 },
      { status: 'completed' },
    );
    expect(state.tests.test_create.status).toBe('failed');
    state = receive(state, 'test_started', { name: 'test_create', nodeId: 'tests', attempt: 2 });
    expect(state.tests.test_create).toMatchObject({ status: 'running', attempt: 2 });
    expect(state.tests.test_create.details).toBeUndefined();
    state = receive(
      state,
      'test_passed',
      { name: 'test_create', nodeId: 'tests', attempt: 2 },
      { status: 'completed' },
    );
    expect(Object.values(state.tests).every((test) => test.status === 'passed')).toBe(true);
  });
  it('tracks repeated stage visits and separate command invocations', () => {
    let state = receive(running(), 'agent_stage', { stage: 'TESTING' });
    state = receive(state, 'command_started', { commandId: 'pytest-1', command: 'pytest' });
    state = receive(
      state,
      'command_finished',
      { commandId: 'pytest-1', command: 'pytest', exitCode: 1 },
      { status: 'failed' },
    );
    state = receive(state, 'agent_stage', { stage: 'DEBUGGING' });
    state = receive(state, 'agent_stage', { stage: 'TESTING' });
    state = receive(state, 'command_started', { commandId: 'pytest-2', command: 'pytest' });
    expect(state.visits.map((visit) => visit.stage)).toEqual(['TESTING', 'DEBUGGING', 'TESTING']);
    expect(state.commands.map((command) => command.status)).toEqual(['failed', 'running']);
  });
  it('applies explicit node transitions and ends the stream on completion', () => {
    let state = receive(running(), 'graph_node_updated', { nodeId: 'agent', state: 'active' });
    expect(state.nodes[0].state).toBe('active');
    state = receive(state, 'graph_node_updated', { nodeId: 'agent', state: 'completed' });
    state = receive(
      state,
      'build_complete',
      { filesTouched: 8, testsPassed: 3, testsTotal: 3 },
      { status: 'completed' },
    );
    expect(state.connection).toBe('complete');
    expect(state.finishedAt).not.toBeNull();
    expect(receive(state, 'agent_stage', { stage: 'PLANNING' })).toBe(state);
    expect(buildReducer(state, { type: 'start', now: 2 })).toEqual({
      ...initialState(),
      connection: 'connecting',
      startedAt: 2,
    });
  });
});

const session: SessionInfo = {
  runId: 'run-1', projectPath: 'D:/Projects/example', projectName: 'example',
  agentName: 'External agent', watching: true, connectedAt: '2026-09-15T12:00:00Z',
  lastActivityAt: '2026-09-15T12:00:00Z', eventCount: 0, trackedFiles: 1,
  filesTouched: 0, warnings: [],
};
const live = () => buildReducer(initialState('live'), { type: 'session', session });
describe('live project state', () => {
  it('retains the latest meaningful activity when graph housekeeping arrives', () => {
    let state = receive(live(), 'agent_stage', { stage: 'IMPLEMENTING', message: 'Building the login API' }, { source: 'agent', agentName: 'My assistant' });
    const current = state.current;
    state = receive(state, 'graph_node_added', { id: 'login', label: 'Login', kind: 'api', state: 'active', description: null }, { source: 'filesystem' });
    state = receive(state, 'graph_node_updated', { nodeId: 'login', state: 'completed' }, { source: 'system' });
    expect(state.current).toBe(current);
    expect(state.nodes).toHaveLength(1);
    expect(state.visits[0].source).toBe('agent');
  });
  it('keeps monitoring after the agent reports completion', () => {
    let state = receive(live(), 'build_complete', { filesTouched: 1, testsPassed: 0, testsTotal: 0 }, { source: 'agent', status: 'completed' });
    expect(state.connection).toBe('streaming');
    expect(state.finishedAt).toBeNull();
    state = receive(state, 'file_modified', { path: 'main.py', nodeId: 'main' }, { source: 'filesystem' });
    expect(state.files).toHaveLength(1);
  });
  it('removes a deleted node and its edges while preserving file history', () => {
    let state = receive(live(), 'graph_node_added', { id: 'main', label: 'Main', kind: 'module', state: 'completed' });
    state = receive(state, 'graph_edge_added', { id: 'connection', source: 'main', target: 'api', label: 'imports', evidence: 'import' });
    state = receive(state, 'file_modified', { path: 'main.py', nodeId: 'main' }, { source: 'filesystem' });
    state = receive(state, 'file_deleted', { path: 'main.py', nodeId: 'main' }, { source: 'filesystem' });
    state = receive(state, 'graph_node_removed', { nodeId: 'main' });
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.files.map((file) => file.kind)).toEqual(['deleted', 'modified']);
  });
  it('restores retained test/stage state and canonical graph from a reconnect snapshot', () => {
    let historical = receive(live(), 'test_passed', { name: 'test_login', nodeId: 'tests', attempt: 1 }, { source: 'agent', status: 'completed' });
    historical = receive(historical, 'agent_stage', { stage: 'VALIDATING' }, { source: 'agent' });
    const latest = receive(historical, 'file_modified', { path: 'main.py', nodeId: 'main' }, { source: 'filesystem', sequence: 800, eventId: 'event-800' }).events.at(-1)!;
    const snapshot = {
      kind: 'snapshot', session: { ...session, eventCount: 800 }, retainedEvents: historical.events,
      events: [latest], graph: { nodes: [{ id: 'old', label: 'Indexed before history retention', kind: 'module', state: 'completed', message: 'Indexed', description: null }], edges: [] },
    };
    const frame = liveFrameSchema.parse(snapshot);
    if (frame.kind !== 'snapshot') throw new Error('Expected snapshot');
    const state = buildReducer(initialState('live'), { type: 'snapshot', ...frame });
    expect(state.tests.test_login.status).toBe('passed');
    expect(state.stage).toBe('VALIDATING');
    expect(state.agentReport?.data.message).toBe('Event');
    expect(state.nodes[0].id).toBe('old');
    expect(state.events).toEqual([latest]);
    expect(state.current?.eventId).toBe('event-800');
    expect(state.session?.eventCount).toBe(800);
  });
  it('replaces every panel when a new project session arrives', () => {
    const previous = receive(live(), 'file_modified', { path: 'main.py', nodeId: 'main' });
    const next = buildReducer(previous, { type: 'session', session: { ...session, runId: 'run-2', projectName: 'other' } });
    expect(next.runId).toBe('run-2');
    expect(next.events).toEqual([]);
    expect(next.files).toEqual([]);
    expect(next.nodes).toEqual([]);
    expect(buildReducer(next, { type: 'event', event: previous.events[0] })).toBe(next);
  });
  it('retains the current project and activity during transport failures', () => {
    const previous = receive(live(), 'file_modified', { path: 'main.py', nodeId: 'main' });
    const disconnected = buildReducer(previous, { type: 'transport', connection: 'error', error: 'Reconnecting' });
    expect(disconnected.files).toEqual(previous.files);
    expect(disconnected.session).toEqual(previous.session);
    expect(disconnected.finishedAt).toBeNull();
  });

  it('retains stage status and identity when the meaningful activity feed rolls over', () => {
    let state = receive(live(), 'agent_stage', { stage: 'DEBUGGING', message: 'Could not connect the API' }, { source: 'agent', status: 'failed', agentName: 'First assistant' });
    const report = state.agentReport!;
    for (let sequence = 2; sequence <= 2002; sequence++) {
      state = receive(state, 'file_modified', { path: 'main.py', nodeId: 'main' }, { source: 'filesystem', sequence, eventId: `save-${sequence}` });
    }
    expect(state.activityEvents).toHaveLength(2000);
    expect(state.activityEvents.some(event => event.eventId === report.eventId)).toBe(false);
    expect(state.agentReport).toBe(report);
    expect(state.visits[0]).toMatchObject({ status: 'failed', eventId: report.eventId, agentName: 'First assistant' });
  });

  it('restores the independent latest agent report when a snapshot contains only later saves in its feed', () => {
    const reported = receive(live(), 'agent_message', { message: 'Connecting the login form' }, { source: 'agent', agentName: 'My assistant' }).events[0];
    const saved = receive(live(), 'file_modified', { path: 'main.py', nodeId: 'main' }, { source: 'filesystem', sequence: 2050, eventId: 'save-2050' }).events[0];
    const state = buildReducer(initialState('live'), {
      type: 'snapshot', session, retainedEvents: [reported, saved], activityEvents: [saved], events: [saved], graph: { nodes: [], edges: [] },
    });
    expect(state.agentReport).toEqual(reported);
    expect(state.current).toEqual(saved);
    expect(state.files[0].eventId).toBe('save-2050');
    const reset = buildReducer(state, { type: 'session', session: { ...session, runId: 'run-2' } });
    expect(reset.agentReport).toBeNull();
    expect(reset.activityEvents).toEqual([]);
    expect(reset.visits).toEqual([]);
  });
});
