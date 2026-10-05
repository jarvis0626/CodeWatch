import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Check, FolderOpen, Pin, Smartphone, X } from 'lucide-react';

interface IntroTutorialProps {
  /** Undefined while the saved preference is loading: do not flash the tutorial. */
  completed: boolean | undefined;
  /** Persist completion in the app's stable user profile before resolving. */
  onComplete: () => Promise<void>;
}

const steps = [
  {
    icon: FolderOpen,
    title: 'Choose your project',
    description: 'Click Choose folder in the full app and select the project you are working on. Keep using your usual editor.',
    detail: 'Saved source files appear automatically in the project map and recent changes.',
    cue: 'Choose folder → Watch your project',
  },
  {
    icon: Bot,
    title: 'Connect your coding agent',
    description: 'Open Connect your AI. Copy the MCP configuration into a compatible coding tool, then give your agent the supplied reporting instructions.',
    detail: 'Work steps appear when the agent reports them. Connecting alone does not capture every action.',
    cue: 'Connect your AI → Reported work steps',
  },
  {
    icon: Pin,
    title: 'Keep the work beside your editor',
    description: 'Always on top opens the compact work flow. Click a step to inspect its files, changes and results.',
    detail: 'Click a file to open its project map. Open full app restores the dashboard while keeping it pinned.',
    cue: 'Pin the flow → Select a step',
  },
  {
    icon: Smartphone,
    title: 'Follow along on your phone',
    description: 'Open Phone view on your computer and scan its QR code with your phone. The link works even when your phone is far away or on a different network.',
    detail: 'Keep your computer online and CodeWatch running while viewing from your phone.',
    cue: 'Phone view → Scan the QR code',
  },
];

export function IntroTutorial({ completed, onComplete }: IntroTutorialProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const completing = useRef(false);
  const open = completed === false && !dismissed;

  useEffect(() => {
    if (!open || !dialog.current) return;
    const modal = dialog.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    modal.showModal();
    document.body.style.overflow = 'hidden';
    title.current?.focus();
    return () => {
      modal.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);

  async function finish() {
    if (completing.current) return;
    completing.current = true;
    setSaving(true); setError('');
    try {
      await onComplete();
      setDismissed(true);
    } catch {
      setError('Could not save your tutorial preference. Please try again.');
    } finally {
      completing.current = false;
      setSaving(false);
    }
  }
  function move(index: number) {
    if (saving) return;
    setStepIndex(Math.max(0, Math.min(steps.length - 1, index)));
    setError('');
  }
  if (!open) return null;
  const step = steps[stepIndex];
  const StepIcon = step.icon;
  const lastStep = stepIndex === steps.length - 1;
  return (
    <dialog className="intro-tutorial" ref={dialog} aria-modal="true" aria-labelledby="intro-tutorial-title" aria-describedby="intro-tutorial-description" data-testid="intro-tutorial"
      onCancel={event => { event.preventDefault(); void finish(); }}
      onKeyDown={event => {
        if (event.key === 'Tab') {
          const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
          const activeIndex = controls.findIndex(control => control === document.activeElement);
          if (controls.length && ((event.shiftKey && activeIndex <= 0) || (!event.shiftKey && (activeIndex < 0 || activeIndex === controls.length - 1)))) {
            event.preventDefault();
            (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
          }
        }
        if (event.key === 'ArrowRight' && !lastStep) { event.preventDefault(); move(stepIndex + 1); }
        if (event.key === 'ArrowLeft' && stepIndex > 0) { event.preventDefault(); move(stepIndex - 1); }
      }}>
      <div className="intro-tutorial-inner">
        <header className="intro-tutorial-header"><div><span className="intro-tutorial-kicker">A quick start</span><h2 id="intro-tutorial-title" ref={title} tabIndex={-1}>Welcome to CodeWatch</h2></div><button className="intro-tutorial-close" type="button" aria-label="Skip tutorial" title="Skip tutorial" data-testid="tutorial-skip" disabled={saving} onClick={() => void finish()}><X size={18} /></button></header>
        <ol className="intro-tutorial-progress" aria-label="Tutorial progress">{steps.map((item, index) => <li key={item.title} aria-current={index === stepIndex ? 'step' : undefined} className={index <= stepIndex ? 'is-reached' : ''}><span className="sr-only">Step {index + 1}: {item.title}</span><span aria-hidden="true" /></li>)}</ol>
        <section className="intro-tutorial-step" aria-live="polite" aria-atomic="true" data-testid="tutorial-step">
          <div className="intro-tutorial-icon" aria-hidden="true"><StepIcon size={31} strokeWidth={1.6} /></div>
          <span className="intro-tutorial-step-number">Step {stepIndex + 1} of {steps.length}</span>
          <h3>{step.title}</h3>
          <p id="intro-tutorial-description">{step.description}</p>
          <div className="intro-tutorial-cue" aria-hidden="true">{step.cue}</div>
          <p className="intro-tutorial-detail">{step.detail}</p>
        </section>
        {error && <p className="intro-tutorial-error" role="alert">{error}</p>}
        <footer className="intro-tutorial-footer"><p>Finish or skip to hide this guide on future launches.</p><div className="intro-tutorial-actions"><button className="intro-tutorial-back" type="button" data-testid="tutorial-back" disabled={stepIndex === 0 || saving} onClick={() => move(stepIndex - 1)}><ArrowLeft size={15} />Back</button>{lastStep || error ? <button className="intro-tutorial-next" type="button" data-testid="tutorial-finish" disabled={saving} onClick={() => void finish()}>{saving ? 'Saving…' : error ? 'Try again' : 'Finish tutorial'}{!saving && <Check size={15} />}</button> : <button className="intro-tutorial-next" type="button" data-testid="tutorial-next" disabled={saving} onClick={() => move(stepIndex + 1)}>{saving ? 'Saving…' : 'Next'}{!saving && <ArrowRight size={15} />}</button>}</div></footer>
      </div>
    </dialog>
  );
}
