import { useEffect, useState } from 'react';
import { Check, Copy, LoaderCircle, QrCode, Smartphone, Square } from 'lucide-react';
import QRCode from 'qrcode';
import type { PhoneShareStatus } from '../types/desktop';

export function PhoneSharePanel({ watching }: { watching: boolean }) {
  const [status, setStatus] = useState<PhoneShareStatus>({ state: 'idle' });
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const desktop = window.codewatchDesktop;
  useEffect(() => {
    if (!desktop?.getPhoneStatus) return;
    let active = true;
    desktop.getPhoneStatus().then(value => { if (active) setStatus(value); }).catch(() => { if (active) setError('Could not check phone sharing. Try again.'); });
    const remove = desktop.onPhoneStatusChanged(value => { if (active) { setStatus(value); setCopied(false); } });
    return () => { active = false; remove(); };
  }, [desktop]);
  useEffect(() => {
    setQr('');
    if (status.state !== 'active' || !status.url) return;
    let active = true;
    QRCode.toDataURL(status.url, { width: 256, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#102018', light: '#ffffff' } })
      .then(value => { if (active) setQr(value); }).catch(() => { if (active) setError('Could not draw the QR code. Use Copy phone link instead.'); });
    return () => { active = false; };
  }, [status.state, status.url]);
  if (!desktop?.startPhoneShare) return null;
  async function start() {
    setError(''); setStatus({ state: 'starting' });
    try { setStatus(await desktop!.startPhoneShare()); }
    catch { setStatus({ state: 'error' }); setError('Could not connect phone sharing. Check your internet connection and try again.'); }
  }
  async function stop() {
    setError('');
    try { setStatus(await desktop!.stopPhoneShare()); }
    catch { setError('Could not stop phone sharing. Please try again.'); }
  }
  async function copy() {
    if (!status.url) return;
    try { await navigator.clipboard.writeText(status.url); setCopied(true); }
    catch { setError('Copy is unavailable. Scan the QR code with your phone instead.'); }
  }
  return <section className="panel phone-share-panel" id="phone-view" aria-labelledby="phone-view-title" data-testid="phone-share-panel">
    <header className="panel-header"><h2 id="phone-view-title"><Smartphone size={16} />Phone view</h2><span className="tiny-label">{status.state === 'active' ? 'SHARING LIVE' : 'VIEW FROM ANYWHERE'}</span></header>
    <div className="phone-share-content"><div className="phone-share-explanation"><h3>Take the work flow with you.</h3><p>Scan a QR code to follow progress in your phone's browser, even on mobile data or a different network.</p><p className="phone-share-note">Sharing sends agent reports, relative file names, changes and result statuses through Cloudflare. Your phone has viewing access. Keep your computer online and CodeWatch running.</p>
      {(status.state === 'idle' || status.state === 'error') && <><button className="button primary-button" type="button" onClick={() => void start()} disabled={!watching}><QrCode size={15} />Enable phone view</button>{!watching && <small>Choose a project and start watching to share its progress.</small>}</>}
      {status.state === 'starting' && <div className="phone-share-actions"><span role="status"><LoaderCircle size={15} className="spin" />Connecting phone view…</span><button className="button reset-button" type="button" onClick={() => void stop()}>Cancel</button></div>}
      {status.state === 'active' && <><div className="phone-share-actions"><button className="button reset-button" type="button" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy phone link'}</button><button className="button reset-button" type="button" onClick={() => void stop()}><Square size={12} />Stop sharing</button></div><p className="phone-share-note">Anyone with this QR code or link can view this session until you stop sharing. It expires {status.expiresAt ? `at ${new Date(status.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'after eight hours'}. A new sharing session gets a new link.</p>{!!status.pairedDevices && <small>{status.pairedDevices} paired {status.pairedDevices === 1 ? 'browser' : 'browsers'}</small>}</>}
      {(error || status.error) && <p className="inline-error" role="alert">{error || status.error}</p>}
    </div>{status.state === 'active' && <div className="phone-qr">{qr ? <img src={qr} width={256} height={256} alt="Scan to open your private CodeWatch phone view" data-testid="phone-qr" /> : <LoaderCircle className="spin" size={24} />}<strong>Scan with your phone's camera</strong><small>Open the link in your browser.</small></div>}</div>
  </section>;
}
