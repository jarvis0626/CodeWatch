import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { buildReducer, initialState } from '../state/build';
import { liveFrameSchema, sessionSchema } from '../types/events';

export async function apiRequest(path: string, body?: object) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'CodeWatch could not complete this request.');
  return data;
}

export function useLiveEvents() {
  const [state, dispatch] = useReducer(buildReducer, 'live', initialState);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requesting = useRef(false);
  useEffect(() => {
    let canceled = false;
    let ws: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let heartbeat: ReturnType<typeof setTimeout>;
    let attempts = 0;
    function connect() {
      if (canceled) return;
      dispatch({ type: 'transport', connection: 'connecting' });
      const override = import.meta.env.VITE_LIVE_WS_URL;
      ws = new WebSocket(override || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/live`);
      const connection = ws;
      const armHeartbeat = () => {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => connection.close(), 35_000);
      };
      armHeartbeat();
      connection.onmessage = ({ data }: MessageEvent<string>) => {
        if (canceled || ws !== connection) return;
        armHeartbeat();
        try {
          const frame = liveFrameSchema.parse(JSON.parse(data));
          if (frame.kind === 'snapshot') {
            attempts = 0;
            dispatch({ type: 'snapshot', ...frame });
          } else if (frame.kind === 'event') dispatch({ type: 'event', event: frame.event });
          else if (frame.kind === 'session') dispatch({ type: 'session', session: frame.session });
        } catch {
          dispatch({ type: 'transport', connection: 'error', error: 'An event could not be read. Reconnecting to refresh the project snapshot.' });
          connection.close();
        }
      };
      connection.onerror = () => connection.close();
      connection.onclose = () => {
        clearTimeout(heartbeat);
        if (canceled || ws !== connection) return;
        dispatch({ type: 'transport', connection: 'error', error: 'Connection lost. CodeWatch will reconnect automatically. Check that the backend is running on port 8000.' });
        retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 10_000));
      };
    }
    connect();
    return () => { canceled = true; clearTimeout(retry); clearTimeout(heartbeat); ws?.close(); };
  }, []);

  const request = useCallback(async (path: string, body: object) => {
    if (requesting.current) return;
    requesting.current = true;
    setBusy(true);
    setRequestError(null);
    try {
      const session = sessionSchema.parse(await apiRequest(path, body));
      dispatch({ type: 'session', session });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : 'Could not connect this project.');
    } finally { requesting.current = false; setBusy(false); }
  }, []);

  return {
    state, busy, requestError,
    watch: (path: string, agentName: string) => request('/api/watch', { path, agentName: agentName.trim() || undefined }),
    stop: () => state.runId ? request('/api/watch/stop', { runId: state.runId }) : Promise.resolve(),
  };
}
