import { describe, expect, it } from 'vitest';
import { CompletionTracker } from './completionNotifications';
import type { AgentEvent } from '../types/events';

const event = (sequence: number, stage: 'IMPLEMENTING' | 'COMPLETE' = 'COMPLETE', patch: Partial<AgentEvent> = {}): AgentEvent => ({ schemaVersion: 1, runId: 'watch_test', eventId: `event-${sequence}`, timestamp: '2026-10-05T12:00:00Z', sequence, source: 'agent', status: stage === 'COMPLETE' ? 'completed' : 'running', type: 'agent_stage', data: { stage, message: `Report ${sequence}` }, ...patch } as AgentEvent);
const buildComplete = (sequence: number): AgentEvent => ({ ...event(sequence), type: 'build_complete', data: { message: 'Finished', filesTouched: 1, testsPassed: 1, testsTotal: 1 } });

describe('reported completion notifications', () => {
  it('silently establishes a baseline for a completed project on initial load', () => {
    const tracker = new CompletionTracker();
    expect(tracker.update('watch_test', [event(1), buildComplete(2)])).toEqual([]);
    expect(tracker.update('watch_test', [event(1), buildComplete(2), event(3)])).toEqual([]);
  });
  it('alerts once for stage and summary events from the same completed work', () => {
    const tracker = new CompletionTracker();
    tracker.update('watch_test', [event(1, 'IMPLEMENTING')]);
    expect(tracker.update('watch_test', [event(1, 'IMPLEMENTING'), event(2), buildComplete(3)], 'My project')).toEqual([{ eventId: 'event-2', runId: 'watch_test', message: 'Report 2', projectName: 'My project' }]);
    expect(tracker.update('watch_test', [event(2), buildComplete(3), event(4)])).toEqual([]);
  });
  it('alerts for the next task only after a new work stage', () => {
    const tracker = new CompletionTracker();
    tracker.update('watch_test', []);
    expect(tracker.update('watch_test', [event(1)])).toHaveLength(1);
    expect(tracker.update('watch_test', [event(2)])).toHaveLength(0);
    expect(tracker.update('watch_test', [event(3, 'IMPLEMENTING'), event(4)])).toHaveLength(1);
  });
  it('ignores scan results, simulation, failed completion and filesystem changes', () => {
    const tracker = new CompletionTracker();
    tracker.update('watch_test', []);
    expect(tracker.update('watch_test', [event(1, 'COMPLETE', { source: 'system' }), event(2, 'COMPLETE', { source: 'simulator' }), event(3, 'COMPLETE', { status: 'failed' }), { ...event(4), type: 'file_modified', source: 'filesystem', data: { path: 'README.md', nodeId: 'readme', message: 'Saved' } }])).toEqual([]);
    expect(tracker.update('watch_test', [buildComplete(5)])).toHaveLength(1);
  });
  it('ignores reconnect snapshots, duplicate IDs and out of order old events', () => {
    const tracker = new CompletionTracker();
    tracker.update('watch_test', [event(1, 'IMPLEMENTING')]);
    const notices = tracker.update('watch_test', [event(2), event(2), buildComplete(3)]);
    expect(notices).toHaveLength(1);
    expect(tracker.update('watch_test', [event(1, 'IMPLEMENTING'), event(2), buildComplete(3)])).toEqual([]);
  });
  it('does not carry notification state across projects', () => {
    const tracker = new CompletionTracker();
    tracker.update('watch_test', []);
    expect(tracker.update('watch_test', [event(1)])).toHaveLength(1);
    const other = { ...event(1), runId: 'watch_other' };
    expect(tracker.update('watch_other', [other])).toEqual([]);
    expect(tracker.update('watch_other', [{ ...event(2, 'IMPLEMENTING'), runId: 'watch_other' }, { ...event(3), runId: 'watch_other' }])).toHaveLength(1);
  });
  it('consumes reports silently when the live view is disabled', () => {
    const tracker = new CompletionTracker();
    tracker.update('watch_test', []);
    expect(tracker.update('watch_test', [event(1)], 'Project', false)).toEqual([]);
    expect(tracker.update('watch_test', [event(1)], 'Project', true)).toEqual([]);
  });
  it('a failed stage does not rearm a previously completed task', () => {
    const tracker = new CompletionTracker();
    tracker.update('watch_test', []);
    expect(tracker.update('watch_test', [event(1)])).toHaveLength(1);
    expect(tracker.update('watch_test', [event(2, 'IMPLEMENTING', { status: 'failed' }), event(3)])).toEqual([]);
    expect(tracker.update('watch_test', [event(4, 'IMPLEMENTING'), event(5)])).toHaveLength(1);
  });
});
