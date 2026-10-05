export interface DesktopPreferences {
  alwaysOnTop: boolean;
  closeToTray: boolean;
  compact: boolean;
  tutorialCompleted: boolean;
}

export interface PhoneShareStatus {
  state: 'idle' | 'starting' | 'active' | 'error';
  url?: string;
  expiresAt?: string;
  pairedDevices?: number;
  error?: string;
}

export interface DesktopApi {
  chooseFolder(): Promise<string | null>;
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
  onPreferencesChanged(listener: (preferences: DesktopPreferences) => void): () => void;
  getPhoneStatus(): Promise<PhoneShareStatus>;
  startPhoneShare(): Promise<PhoneShareStatus>;
  stopPhoneShare(): Promise<PhoneShareStatus>;
  onPhoneStatusChanged(listener: (status: PhoneShareStatus) => void): () => void;
}

declare global {
  interface Window {
    codewatchDesktop?: DesktopApi;
  }
}
