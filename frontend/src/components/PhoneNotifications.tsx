import { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, LoaderCircle } from 'lucide-react';

interface PushStatus { enabled: boolean; publicKey: string | null; error?: string }

function applicationServerKey(value: string): ArrayBuffer {
  const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(decoded, character => character.charCodeAt(0)).buffer;
}
async function pushRequest(path: string, body?: object) {
  const response = await fetch(path, { cache: 'no-store', ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Could not update phone alerts. Please try again.');
  return result as PushStatus;
}

export function PhoneNotifications({ onCopyPairingLink }: { onCopyPairingLink?: () => Promise<void> }) {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copiedPairingLink, setCopiedPairingLink] = useState(false);
  const registration = useRef<Promise<ServiceWorkerRegistration> | null>(null);
  const applePhone = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
  const supported = isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && (!applePhone || standalone);
  useEffect(() => {
    let active = true;
    void pushRequest('/api/push/status').then(result => { if (active) setStatus(result); }).catch(() => { if (active) setError('Could not load notification settings. Reopen this phone view to try again.'); });
    return () => { active = false; };
  }, []);
  async function enable() {
    if (busy || !status?.publicKey || !supported) return;
    setBusy(true); setError('');
    try {
      // iPhone requires permission to be requested directly from the tap.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { setError(permission === 'denied' ? 'Notifications are blocked. Allow them in your browser or phone settings, then try again.' : 'Phone alerts were not enabled. Tap Enable completion alerts when you are ready.'); return; }
      registration.current ??= navigator.serviceWorker.register('/phone-sw.js', { scope: '/phone' });
      const worker = await registration.current;
      await navigator.serviceWorker.ready;
      // A previous share may have left a subscription bound to an older VAPID key.
      const previous = await worker.pushManager.getSubscription();
      if (previous) await previous.unsubscribe();
      const subscription = await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(status.publicKey) });
      await pushRequest('/api/push/subscribe', subscription.toJSON());
      setStatus(current => current ? { ...current, enabled: true } : current);
    } catch (cause) {
      registration.current = null;
      setError(cause instanceof Error ? cause.message : 'Could not enable completion alerts. Please try again.');
    } finally { setBusy(false); }
  }
  async function disable() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await pushRequest('/api/push/unsubscribe', {});
      setStatus(current => current ? { ...current, enabled: false } : current);
      const worker = await navigator.serviceWorker.getRegistration('/phone');
      await (await worker?.pushManager.getSubscription())?.unsubscribe();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not turn off completion alerts. Please try again.'); }
    finally { setBusy(false); }
  }
  async function copyPairingLink() {
    setError('');
    try { await onCopyPairingLink?.(); setCopiedPairingLink(true); }
    catch { setError('Could not copy the link. Use Copy phone link in CodeWatch on your computer.'); }
  }
  return <section className="phone-notifications" aria-label="Phone completion alerts" data-testid="phone-notifications"><h2><Bell size={16} />Completion alerts</h2><p>Get an alert when the agent reports work complete, including with this view closed or your phone locked. Keep CodeWatch online and phone sharing enabled.</p>{applePhone && !standalone ? <div className="phone-install-help"><strong>Set up alerts on iPhone</strong><p>In Safari, tap Share, then Add to Home Screen. Open CodeWatch from its new icon. If it asks to pair, paste the private phone link copied here or from CodeWatch on your computer, then enable alerts.</p>{onCopyPairingLink && <><button type="button" className="flow-text-button" onClick={() => void copyPairingLink()}>Copy pairing link</button><small>{copiedPairingLink ? 'Copied. Paste this link into CodeWatch after opening its Home Screen icon.' : 'Copy before adding to your Home Screen. This private link connects to your shared project.'}</small></>}</div> : !supported ? <p className="phone-alert-help">This browser does not support background alerts here. Open the HTTPS phone link in a browser that supports web push.</p> : <div className="phone-notification-actions">{status?.enabled ? <><span><Bell size={14} />Alerts enabled on this phone</span><button type="button" className="flow-text-button" disabled={busy} onClick={() => void disable()}><BellOff size={13} />{busy ? 'Turning off…' : 'Turn off alerts'}</button></> : <button type="button" className="flow-text-button" disabled={busy || !status?.publicKey} onClick={() => void enable()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Bell size={14} />}{busy ? 'Enabling alerts…' : 'Enable completion alerts'}</button>}</div>}{status?.error && <p className="phone-alert-help">{status.error}</p>}{error && <p className="phone-alert-error" role="alert">{error}</p>}<small>Alerts end when sharing expires, stops, or the watched project changes. Browser and phone notification settings control delivery.</small></section>;
}
