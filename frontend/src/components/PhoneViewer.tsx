import { useEffect, useReducer, useRef, useState } from 'react';
import { GitBranch, LoaderCircle, Smartphone } from 'lucide-react';
import { buildReducer, initialState } from '../state/build';
import { liveFrameSchema } from '../types/events';
import { ActivityFlow } from './ActivityFlow';
import { FileChanges } from './FileChanges';
import { TestResults } from './TestResults';
import { PhoneNotifications } from './PhoneNotifications';
import { CompletionNotification } from './CompletionNotification';
import { useCompletionNotifications } from '../hooks/useCompletionNotifications';

export function PhoneViewer() {
  const [state, dispatch] = useReducer(buildReducer, 'live', initialState);
  const completion = useCompletionNotifications(state);
  const [connecting, setConnecting] = useState(true);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState('');
  const [pairingLink, setPairingLink] = useState('');
  const [pairingError, setPairingError] = useState('');
  const [pairAttempt, setPairAttempt] = useState(0);
  const pairing = useRef<{ token: string; attempt: number; response: Promise<Response> } | null>(null);
  const revision = useRef<string | null>(null);
  const [token, setToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token'));
  useEffect(() => {
    const manifest = document.createElement('link'); manifest.rel = 'manifest'; manifest.href = '/phone.webmanifest';
    const icon = document.createElement('link'); icon.rel = 'apple-touch-icon'; icon.href = '/phone-icon-192.png';
    document.head.append(manifest, icon);
    return () => { manifest.remove(); icon.remove(); };
  }, []);
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
          if (active) { setConnecting(false); setEnded(true); setError('This browser is not paired, or its phone link has ended. Pair it with the current private phone link from CodeWatch on your computer.'); }
          return;
        }
        if (response.status === 304) {
          if (active) { dispatch({ type: 'transport', connection: 'streaming' }); setError(''); }
        } else {
          if (!response.ok) throw new Error('unavailable');
          const frame = liveFrameSchema.parse(await response.json());
          if (frame.kind !== 'snapshot') throw new Error('invalid snapshot');
          if (active) { revision.current = response.headers.get('ETag'); dispatch({ type: 'snapshot', ...frame }); setConnecting(false); setEnded(false); setError(''); }
        }
      } catch {
        if (active) { dispatch({ type: 'transport', connection: 'error' }); setError('Connection paused. Reconnecting… Keep CodeWatch online, or scan a new QR code if sharing has ended.'); }
      }
      if (active) timer = setTimeout(() => void poll(), 2000);
    }
    async function connect() {
      if (token) {
        // Keep one pairing promise across React's development effect replay.
        if (pairing.current?.token !== token || pairing.current.attempt !== pairAttempt) pairing.current = { token, attempt: pairAttempt, response: fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }) };
        try {
          const response = await pairing.current.response;
          if (!response.ok) {
            if (active) { setConnecting(false); setEnded(true); setError('This QR code is no longer available. Use the current private phone link from CodeWatch on your computer.'); }
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
  }, [token, pairAttempt]);
  function pairFromLink(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const link = new URL(pairingLink.trim());
      const pairToken = new URLSearchParams(link.hash.slice(1)).get('token');
      if (link.origin !== location.origin || link.pathname !== '/phone' || !pairToken || pairToken.length > 512) throw new Error('invalid');
      setPairingLink(''); setPairingError(''); setEnded(false); setConnecting(true); setError(''); revision.current = null;
      setToken(pairToken); setPairAttempt(attempt => attempt + 1);
    } catch { setPairingError('Paste the private phone link for this connection, copied using Copy phone link on your computer.'); }
  }
  return <div className="phone-viewer" data-testid="phone-viewer"><header className="phone-viewer-header"><div><GitBranch size={22} /><strong>CodeWatch</strong></div><span><Smartphone size={13} />Phone view · Read only</span></header><main><div className="phone-project"><h1>{state.session?.projectName || 'Your work, wherever you are'}</h1><p>Live reports and saved file activity from your computer.</p></div>{!ended && <CompletionNotification notice={completion.notice} onDismiss={completion.dismiss} />}{error && <div className={`notice ${ended ? 'error-notice' : ''}`} role={ended ? 'alert' : 'status'}>{error}</div>}{connecting && !ended && !state.session && <div className="phone-connecting" role="status"><LoaderCircle className="spin" size={22} />Connecting to your computer…</div>}{ended && <form className="phone-pair-form" onSubmit={pairFromLink}><h2>Pair this phone view</h2><p>If you installed CodeWatch on your Home Screen, open it there and paste the private phone link copied from your computer. The link stays private and is cleared after pairing.</p><label htmlFor="phone-private-link">Private phone link</label><input id="phone-private-link" type="password" value={pairingLink} onChange={event => setPairingLink(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste the copied phone link" /><button type="submit" className="flow-text-button" disabled={!pairingLink.trim()}>Pair this phone</button>{pairingError && <p className="phone-alert-error" role="alert">{pairingError}</p>}</form>}{!ended && state.session && <><PhoneNotifications onCopyPairingLink={token && navigator.clipboard ? () => navigator.clipboard.writeText(location.origin + "/phone#token=" + encodeURIComponent(token)) : undefined} /><ActivityFlow key={state.runId} state={state} compact /><FileChanges files={state.files} /><TestResults tests={state.tests} mode="live" /></>}<footer>Keep CodeWatch running on your computer. Stop sharing there to disconnect this phone.</footer></main></div>;
}
