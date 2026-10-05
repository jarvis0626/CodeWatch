import { useEffect, useState } from 'react';
import { Maximize2, PanelBottom, Pin } from 'lucide-react';
import type { DesktopPreferences } from '../types/desktop';

interface Props {
  preferences?: DesktopPreferences | null;
  onPreferencesChange?: (preferences: DesktopPreferences) => void;
}

export function DesktopControls({ preferences: providedPreferences, onPreferencesChange }: Props = {}) {
  const desktop = window.codewatchDesktop;
  const [localPreferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const preferences = providedPreferences ?? localPreferences;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    setError('');
    const update = (value: DesktopPreferences) => {
      if (!active) return;
      setPreferences(value);
      onPreferencesChange?.(value);
    };
    const unsubscribe = desktop.onPreferencesChanged(update);
    desktop.getPreferences().then((value) => {
      update(value);
    }).catch(() => {
      if (active) setError('Could not load your window preferences.');
    });
    return () => { active = false; unsubscribe(); };
  }, [desktop, attempt, onPreferencesChange]);

  async function change(patch: Partial<DesktopPreferences>) {
    if (!desktop || !preferences || busy) return;
    setBusy(true);
    setError('');
    try {
      const updated = await desktop.setPreferences(patch);
      setPreferences(updated);
      onPreferencesChange?.(updated);
    } catch {
      setError('Could not save your window preferences. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!desktop) return null;
  return <div className="desktop-controls">
    <div className="mode-switch" role="group" aria-label="Window preferences" aria-busy={busy}>
      {preferences?.compact && <button type="button" disabled={busy} onClick={() => void change({ compact: false })} title="Open the full dashboard while keeping your pin preference"><Maximize2 size={12} />Open full app</button>}
      <button type="button" className={preferences?.alwaysOnTop ? 'active' : ''} aria-pressed={preferences?.alwaysOnTop ?? false} disabled={!preferences || busy} onClick={() => void change({ alwaysOnTop: !preferences?.alwaysOnTop })} title={preferences?.compact ? 'Unpin and restore the full dashboard' : 'Pin the activity flow above other windows'}><Pin size={12} />{preferences?.compact && preferences.alwaysOnTop ? 'Unpin' : 'Always on top'}</button>
      {!preferences?.compact && preferences?.alwaysOnTop && <button type="button" disabled={busy} onClick={() => void change({ compact: true })} title="Return to the compact activity flow"><PanelBottom size={12} />Show companion</button>}
      {!preferences?.compact && <button type="button" className={preferences?.closeToTray ? 'active' : ''} aria-pressed={preferences?.closeToTray ?? false} disabled={!preferences || busy} onClick={() => void change({ closeToTray: !preferences?.closeToTray })} title="Keep CodeWatch running in the system tray when you close its window"><PanelBottom size={12} />Close to tray</button>}
    </div>
    {error && <div className="desktop-controls-error"><span className="inline-error" role="alert">{error}</span>{!preferences && <button type="button" className="button reset-button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>}</div>}
  </div>;
}
