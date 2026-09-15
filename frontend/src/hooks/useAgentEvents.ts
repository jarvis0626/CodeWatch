import { useCallback, useEffect, useReducer, useRef } from 'react';
import { agentEventSchema } from '../types/events';
import { buildReducer, initialState } from '../state/build';

function socketUrl(): string {
  return (
    import.meta.env.VITE_WS_URL ||
    `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/build`
  );
}

export function useAgentEvents() {
  const [state, dispatch] = useReducer(buildReducer, undefined, initialState);
  const socket = useRef<WebSocket | null>(null);
  const generation = useRef(0);
  const watchdog = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const disconnect = useCallback(() => {
    generation.current += 1;
    clearTimeout(watchdog.current);
    const previous = socket.current;
    socket.current = null;
    if (previous && previous.readyState < WebSocket.CLOSING) previous.close();
  }, []);

  const start = useCallback(
    (prompt: string) => {
      if (socket.current && socket.current.readyState < WebSocket.CLOSING) return;
      disconnect();
      const token = generation.current;
      dispatch({ type: 'start', now: Date.now() });
      let completed = false;
      const fail = (message: string) => {
        if (generation.current !== token) return;
        disconnect();
        dispatch({ type: 'error', message });
      };
      const armWatchdog = () => {
        clearTimeout(watchdog.current);
        watchdog.current = setTimeout(
          () =>
            fail(
              'The event stream timed out. Check that the backend is running, then start a new build.',
            ),
          10_000,
        );
      };
      try {
        const ws = new WebSocket(socketUrl());
        socket.current = ws;
        armWatchdog();
        ws.onopen = () => {
          if (generation.current !== token) return;
          ws.send(JSON.stringify({ action: 'start', prompt }));
        };
        ws.onmessage = ({ data }: MessageEvent<string>) => {
          if (generation.current !== token) return;
          try {
            const event = agentEventSchema.parse(JSON.parse(data));
            dispatch({ type: 'event', event });
            completed = event.type === 'build_complete';
            if (completed) {
              clearTimeout(watchdog.current);
              ws.close(1000, 'Build complete');
            } else armWatchdog();
          } catch {
            fail(
              'The backend sent an invalid event. Check that the frontend and backend use the same event schema.',
            );
          }
        };
        ws.onerror = () =>
          fail('Could not connect to CodeWatch. Start the backend on port 8000, then try again.');
        ws.onclose = () => {
          if (generation.current !== token) return;
          clearTimeout(watchdog.current);
          socket.current = null;
          if (!completed)
            fail(
              'The connection closed before the build finished. Start a new build to try again.',
            );
        };
      } catch {
        fail(
          'Could not open the event connection. Check VITE_WS_URL in your frontend configuration.',
        );
      }
    },
    [disconnect],
  );

  const reset = useCallback(() => {
    disconnect();
    dispatch({ type: 'reset' });
  }, [disconnect]);
  useEffect(() => disconnect, [disconnect]);
  return { state, start, reset };
}
