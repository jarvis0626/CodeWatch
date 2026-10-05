'use strict';

// The native process watches this small local feed even with the window hidden.
// A completion stage and its build_complete event describe one reported outcome.
function createCompletionNotifier({ request, notify, log = () => {}, intervalMs = 1000 }) {
  let started = false, closed = false, timer, pending;
  let initialized = false, runId = null, sequence = 0, completed = false;
  let failureReported = false;
  const controller = new AbortController();

  function consume(frame) {
    if (closed) return;
    if (!frame || !Array.isArray(frame.events) || !Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
      throw new Error('Invalid completion feed');
    }
    const current = frame.session;
    if (current !== null && (!current || typeof current.runId !== 'string' || typeof current.projectName !== 'string' ||
        typeof current.watching !== 'boolean')) throw new Error('Invalid completion session');
    const first = !initialized;
    initialized = true;
    if (current?.runId !== runId) {
      runId = current?.runId ?? null; sequence = 0; completed = false;
    }
    if (!current) return;
    const events = frame.events.filter(event => event && event.runId === runId && event.source === 'agent' &&
      Number.isSafeInteger(event.sequence) && event.sequence > sequence && event.sequence <= frame.sequence)
      .sort((a, b) => a.sequence - b.sequence);
    for (const event of events) {
      const terminal = event.status === 'completed' &&
        ((event.type === 'agent_stage' && event.data?.stage === 'COMPLETE') || event.type === 'build_complete');
      if (event.type === 'agent_stage' && event.data?.stage !== 'COMPLETE' &&
          ['pending', 'running', 'completed'].includes(event.status)) completed = false;
      if (!terminal || completed) continue;
      completed = true;
      if (!first && current.watching) {
        notify({ runId, eventId: event.eventId, sequence: event.sequence, title: 'Work reported complete',
          body: `${current.projectName.slice(0, 100)}: Your coding agent reported completion.` });
      }
    }
    sequence = Math.max(sequence, frame.sequence);
  }
  async function poll() {
    if (closed || pending) return pending;
    pending = (async () => {
      try { consume(await request(controller.signal)); failureReported = false; }
      catch { if (!closed && !failureReported) { failureReported = true;
        log('Completion alerts will retry when the local service reconnects.'); } }
      finally { pending = undefined; }
    })();
    return pending;
  }
  function schedule() {
    if (closed) return;
    timer = setTimeout(async () => { await poll(); schedule(); }, intervalMs);
    timer.unref?.();
  }
  return {
    async start() { if (started || closed) return; started = true; await poll(); schedule(); },
    poll,
    consume,
    async close() { closed = true; clearTimeout(timer); controller.abort(); await pending; },
  };
}

module.exports = { createCompletionNotifier };
