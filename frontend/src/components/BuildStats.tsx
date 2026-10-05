import { Boxes, CheckCheck, FileCode2, Radio } from 'lucide-react';
import type { BuildState } from '../state/build';

export function BuildStats({ state }: { state: BuildState }) {
  const tests = Object.values(state.tests);
  const passed = tests.filter((test) => test.status === 'passed').length;
  const stats = [
    {
      label: 'Files touched',
      value: state.session?.filesTouched ?? new Set(state.files.map((file) => file.path)).size,
      icon: FileCode2,
      detail: 'in this run',
    },
    {
      label: 'Events received',
      value: (state.session?.eventCount ?? state.events.length).toString().padStart(2, '0'),
      icon: Radio,
      detail: state.connection === 'streaming' ? 'streaming live' : 'universal events',
    },
    {
      label: 'Tests passing',
      value: `${passed} / ${tests.length}`,
      icon: CheckCheck,
      detail: tests.some((test) => test.status === 'failed')
        ? 'failure detected'
        : tests.length
          ? 'latest results'
          : state.mode === 'live' ? 'no results reported' : 'awaiting test suite',
    },
    {
      label: state.mode === 'live' ? 'Indexed files' : 'Architecture nodes',
      testId: 'architecture-nodes',
      value: (state.mode === 'live' ? state.nodes.filter((node) => node.kind !== 'agent' && !!node.path).length : state.nodes.length).toString().padStart(2, '0'),
      icon: Boxes,
      detail: state.mode === 'live' ? `${state.edges.filter((edge) => edge.evidence === 'import').length} import links` : `${state.edges.length} connections`,
    },
  ];
  return (
    <section className="stats-grid" aria-label="Build statistics">
      {stats.map(({ label, value, icon: Icon, detail, testId }) => (
        <div className="stat" key={label}>
          <div className="stat-label">
            <Icon size={14} />
            {label}
          </div>
          <div className="stat-bottom">
            <strong data-testid={testId ?? label.toLowerCase().replaceAll(' ', '-')}>{value}</strong>
            <span>{detail}</span>
          </div>
        </div>
      ))}
    </section>
  );
}
