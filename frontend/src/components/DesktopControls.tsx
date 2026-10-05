import { useEffect, useState } from 'react';
import { PanelBottom, Pin } from 'lucide-react';
import type { DesktopPreferences } from '../types/desktop';

export function DesktopControls() {
  const desktop = window.codewatchDesktop;
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    setError('');
    desktop.getPreferences().then((value) => {
      if (active) setPreferences(value);
    }).catch(() => {
      if (active) setError('Could not load your window preferences.');
    });
    return () => { active = false; };
  }, [desktop, attempt]);

  async function toggle(key: keyof DesktopPreferences) {
    if (!desktop || !preferences || busy) return;
    setBusy(true);
    setError('');
    try {
      setPreferences(await desktop.setPreferences({ [key]: !preferences[key] }));
    } catch {
      setError('Could not save your window preferences. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!desktop) return null;
  return <div className="desktop-controls">
    <div className="mode-switch" role="group" aria-label="Window preferences" aria-busy={busy}>
      <button type="button" className={preferences?.alwaysOnTop ? 'active' : ''} aria-pressed={preferences?.alwaysOnTop ?? false} disabled={!preferences || busy} onClick={() => void toggle('alwaysOnTop')} title="Keep CodeWatch visible above other windows"><Pin size={12} />Always on top</button>
      <button type="button" className={preferences?.closeToTray ? 'active' : ''} aria-pressed={preferences?.closeToTray ?? false} disabled={!preferences || busy} onClick={() => void toggle('closeToTray')} title="Keep CodeWatch running in the system tray when you close its window"><PanelBottom size={12} />Close to tray</button>
    </div>
    {error && <div className="desktop-controls-error"><span className="inline-error" role="alert">{error}</span>{!preferences && <button type="button" className="button reset-button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>}</div>}
  </div>;
}
