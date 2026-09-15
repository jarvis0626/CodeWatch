import { describe, expect, it } from 'vitest';
import { agentEventSchema } from '../types/events';
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
