import { useEffect, useState } from 'react';
import type { DesktopPreferences } from '../types/desktop';

export function useDesktopPreferences() {
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  useEffect(() => {
    const desktop = window.codewatchDesktop;
    if (!desktop) return;
    let active = true;
    const unsubscribe = desktop.onPreferencesChanged((value) => { if (active) setPreferences(value); });
    void desktop.getPreferences().then((value) => { if (active) setPreferences(value); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  return { preferences, setPreferences };
}
