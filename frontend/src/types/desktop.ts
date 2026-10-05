export interface DesktopPreferences {
  alwaysOnTop: boolean;
  closeToTray: boolean;
}

export interface DesktopApi {
  chooseFolder(): Promise<string | null>;
  getPreferences(): Promise<DesktopPreferences>;
  setPreferences(patch: Partial<DesktopPreferences>): Promise<DesktopPreferences>;
}

declare global {
  interface Window {
    codewatchDesktop?: DesktopApi;
  }
}
