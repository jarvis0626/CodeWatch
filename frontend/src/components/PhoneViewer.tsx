import { useEffect, useReducer, useRef, useState } from 'react';
import { GitBranch, LoaderCircle, Smartphone } from 'lucide-react';
import { buildReducer, initialState } from '../state/build';
import { liveFrameSchema } from '../types/events';
import { ActivityFlow } from './ActivityFlow';
import { FileChanges } from './FileChanges';
import { TestResults } from './TestResults';

export function PhoneViewer() {
  const [state, dispatch] = useReducer(buildReducer, 'live', initialState);
  const [connecting, setConnecting] = useState(true);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  const pairing = useRef<Promise<Response> | null>(null);
  const revision = useRef<string | null>(null);
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token'));
  useEffect(() => {
    if (location.hash) history.replaceState(null, '', location.pathname);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch('/api/snapshot', { cache: 'no-store', signal: controller.signal,
          headers: revision.current ? { 'If-None-Match': revision.current } : undefined });
        if (response.status === 401 || response.status === 403 || response.status === 410) {
          if (active) { setConnecting(false); setEnded(true); setError('This phone link has ended. Enable phone view on your computer and scan its new QR code.'); }
          return;
        }
        if (response.status === 304) {
          if (active) { dispatch({ type: 'transport', connection: 'streaming' }); setError(''); }
        } else {
          if (!response.ok) throw new Error('unavailable');
          const frame = liveFrameSchema.parse(await response.json());
          if (frame.kind !== 'snapshot') throw new Error('invalid snapshot');
          if (active) { revision.current = response.headers.get('ETag'); dispatch({ type: 'snapshot', ...frame }); setConnecting(false); setError(''); }
        }
      } catch {
        if (active) { dispatch({ type: 'transport', connection: 'error' }); setError('Connection paused. Reconnecting… Keep CodeWatch online, or scan a new QR code if sharing has ended.'); }
      }
      if (active) timer = setTimeout(() => void poll(), 2000);
    }
    async function connect() {
      if (token) {
        // Keep one pairing promise across React's development effect replay.
        pairing.current ??= fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
        try {
          const response = await pairing.current;
          if (!response.ok) {
            if (active) { setConnecting(false); setEnded(true); setError('This QR code is no longer available. Scan a new code from CodeWatch on your computer.'); }
            return;
          }
        } catch {
          if (active) { setConnecting(false); setEnded(true); setError('Could not pair this browser. Reopen the QR link when your computer is online.'); }
          return;
        }
      }
      if (active) void poll();
    }
    void connect();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [token]);
  return <div className="phone-viewer" data-testid="phone-viewer"><header className="phone-viewer-header"><div><GitBranch size={22} /><strong>CodeWatch</strong></div><span><Smartphone size={13} />Phone view · Read only</span></header><main><div className="phone-project"><h1>{state.session?.projectName || 'Your work, wherever you are'}</h1><p>Live reports and saved file activity from your computer.</p></div>{error && <div className={`notice ${ended ? 'error-notice' : ''}`} role={ended ? 'alert' : 'status'}>{error}</div>}{connecting && !ended && !state.session && <div className="phone-connecting" role="status"><LoaderCircle className="spin" size={22} />Connecting to your computer…</div>}{!ended && state.session && <><ActivityFlow key={state.runId} state={state} compact /><FileChanges files={state.files} /><TestResults tests={state.tests} mode="live" /></>}<footer>Keep CodeWatch running on your computer. Stop sharing there to disconnect this phone.</footer></main></div>;
}
