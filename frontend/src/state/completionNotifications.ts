import type { AgentEvent } from '../types/events';

export interface CompletionNotice {
  eventId: string;
  runId: string;
  message: string;
  projectName: string;
}

/** Track reported work, rather than filesystem activity or a restored history. */
export class CompletionTracker {
  private runId: string | null = null;
  private sequence = 0;
  private completed = false;

  update(runId: string | null, events: AgentEvent[], projectName = 'Your project', notify = true): CompletionNotice[] {
    if (!runId) return [];
    const changedRun = this.runId !== runId;
    if (changedRun) { this.runId = runId; this.sequence = 0; this.completed = false; }
    const notices: CompletionNotice[] = [];
    for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
      if (event.runId !== runId || event.sequence <= this.sequence) continue;
      this.sequence = event.sequence;
      if (event.source !== 'agent') continue;
      if (event.type === 'agent_stage' && event.data.stage !== 'COMPLETE' && event.status !== 'failed') {
        this.completed = false;
      } else if (event.status === 'completed' && (event.type === 'build_complete' || (event.type === 'agent_stage' && event.data.stage === 'COMPLETE'))) {
        if (!this.completed && !changedRun && notify) notices.push({ eventId: event.eventId, runId, message: event.data.message, projectName });
        this.completed = true;
      }
    }
    return notices;
  }
}
