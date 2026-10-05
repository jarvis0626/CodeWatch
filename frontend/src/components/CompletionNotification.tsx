import { CheckCircle2, X } from 'lucide-react';
import type { CompletionNotice } from '../state/completionNotifications';
import '../styles/completion-notifications.css';

export function CompletionNotification({ notice, onDismiss }: { notice: CompletionNotice | null; onDismiss: () => void }) {
  if (!notice) return null;
  return <aside className="completion-notification" role="status" aria-live="polite" data-testid="completion-notice"><CheckCircle2 size={20} /><div><strong>Work reported complete</strong><small>{notice.projectName} · Agent-reported</small><p>{notice.message}</p></div><button type="button" onClick={onDismiss} aria-label="Dismiss completion notification"><X size={17} /></button></aside>;
}
