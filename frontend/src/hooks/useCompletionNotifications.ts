import { useEffect, useRef, useState } from 'react';
import type { BuildState } from '../state/build';
import { CompletionTracker, type CompletionNotice } from '../state/completionNotifications';

export function useCompletionNotifications(state: BuildState, enabled = true) {
  const tracker = useRef(new CompletionTracker());
  const [notice, setNotice] = useState<CompletionNotice | null>(null);
  useEffect(() => {
    const latest = tracker.current.update(state.runId, [...state.activityEvents, ...state.events], state.session?.projectName, enabled && state.mode === 'live').at(-1);
    if (latest) setNotice(latest);
    else setNotice(current => current && current.runId !== state.runId ? null : current);
  }, [state.runId, state.activityEvents, state.events, state.session?.projectName, state.mode, enabled]);
  return { notice, dismiss: () => setNotice(null) };
}
