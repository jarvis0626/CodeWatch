import { Check, Circle, LoaderCircle, X } from 'lucide-react';

export function StatusIcon({
  status,
  size = 14,
  animate = true,
}: {
  status: string;
  size?: number;
  animate?: boolean;
}) {
  if (status === 'completed' || status === 'passed')
    return <Check size={size} className="text-success" aria-label="Completed" />;
  if (status === 'failed' || status === 'error')
    return <X size={size} className="text-danger" aria-label="Failed" />;
  if (status === 'active' || status === 'running')
    return (
      <LoaderCircle
        size={size}
        className={`${animate ? 'spin ' : ''}text-accent`}
        aria-label="Running"
      />
    );
  return <Circle size={size} className="text-muted" aria-label="Pending" />;
}
