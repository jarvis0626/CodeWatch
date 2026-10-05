'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { createCompletionNotifier } = require('./completion-notifications.cjs');

const progress = (sequence, stage = 'IMPLEMENTING', status = 'running', runId = 'run-1') => ({
  eventId: `event-${sequence}`, runId, sequence, source: 'agent', type: 'agent_stage', status, data: { stage },
});
const complete = sequence => ({ ...progress(sequence, 'COMPLETE', 'completed'), type: 'build_complete', data: {} });
const frame = (sequence, events = [], runId = 'run-1', watching = true) => ({
  session: { runId, projectName: 'CodeWatch', watching }, sequence, events,
});
function fixture() {
  const alerts = [];
  const notifier = createCompletionNotifier({ request: async () => frame(0), notify: alert => alerts.push(alert) });
  return { alerts, notifier };
}

test('old completion history is silent on launch and snapshot replay', () => {
  const { alerts, notifier } = fixture();
  notifier.consume(frame(3, [progress(1), progress(2, 'COMPLETE', 'completed'), complete(3)]));
  notifier.consume(frame(3, [progress(1), progress(2, 'COMPLETE', 'completed'), complete(3)]));
  notifier.consume(frame(4000, [progress(2, 'COMPLETE', 'completed'), complete(3)]));
  assert.equal(alerts.length, 0);
});

test('fresh completion alerts once across paired events, scans and repeated reports', () => {
  const { alerts, notifier } = fixture();
  notifier.consume(frame(1, [progress(1)]));
  notifier.consume(frame(3, [progress(1), progress(2, 'COMPLETE', 'completed'), complete(3)]));
  notifier.consume(frame(4, [complete(3), complete(4)]));
  notifier.consume(frame(2000, [complete(4)]));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].title, 'Work reported complete');
  assert.equal(alerts[0].body, 'CodeWatch: Your coding agent reported completion.');
});

test('new reported work rearms completion; failed and simulated reports stay silent', () => {
  const { alerts, notifier } = fixture();
  notifier.consume(frame(0));
  notifier.consume(frame(2, [progress(1), complete(2)]));
  notifier.consume(frame(5, [progress(3), progress(4, 'COMPLETE', 'failed'), { ...complete(5), source: 'simulator' }]));
  assert.equal(alerts.length, 1);
  notifier.consume(frame(6, [complete(6)]));
  assert.equal(alerts.length, 2);
});

test('switching projects never processes events belonging to the previous project', () => {
  const { alerts, notifier } = fixture();
  notifier.consume(frame(0));
  notifier.consume(frame(3, [complete(2), progress(1, 'IMPLEMENTING', 'running', 'run-2'),
    { ...complete(3), runId: 'run-2' }], 'run-2'));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].runId, 'run-2');
});

test('a failed stage after completion does not rearm a duplicate completion', () => {
  const { alerts, notifier } = fixture();
  notifier.consume(frame(0));
  notifier.consume(frame(1, [complete(1)]));
  notifier.consume(frame(3, [progress(2, 'VALIDATING', 'failed'), complete(3)]));
  assert.equal(alerts.length, 1);
});

test('stopped watchers do not alert and a late response after shutdown is ignored', async () => {
  const alerts = [];
  let resolve;
  const notifier = createCompletionNotifier({ request: () => new Promise(done => { resolve = done; }),
    notify: alert => alerts.push(alert) });
  notifier.consume(frame(0));
  notifier.consume(frame(1, [complete(1)], 'run-1', false));
  const polling = notifier.poll();
  const closing = notifier.close();
  resolve(frame(3, [progress(2), complete(3)]));
  await polling; await closing;
  assert.equal(alerts.length, 0);
});

test('a temporary service error retries without resetting the completion cursor', async () => {
  const alerts = [];
  let attempts = 0;
  const notifier = createCompletionNotifier({ request: async () => {
    if (++attempts === 2) throw new Error('offline');
    return attempts === 1 ? frame(0) : frame(2, [progress(1), complete(2)]);
  }, notify: alert => alerts.push(alert) });
  await notifier.poll(); await notifier.poll(); await notifier.poll(); await notifier.poll();
  assert.equal(alerts.length, 1);
  await notifier.close();
});
