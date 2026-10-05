export interface DesktopPreferences {
  alwaysOnTop: boolean;
  closeToTray: boolean;
  compact: boolean;
}

export interface DesktopApi {
  chooseFolder(): Promise<string | null>;
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  onPreferencesChanged(listener: (preferences: DesktopPreferences) => void): () => void;
}

declare global {
  interface Window {
    codewatchDesktop?: DesktopApi;
  }
}
