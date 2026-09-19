import { FlaskConical } from 'lucide-react';
import { sourceLabel, type TestResult } from '../types/events';
import { StatusIcon } from './StatusIcon';

export function TestResults({ tests, mode }: { tests: Record<string, TestResult>; mode: 'live' | 'demo' }) {
  const results = Object.values(tests);
  const passed = results.filter((test) => test.status === 'passed').length;
  const failed = results.some((test) => test.status === 'failed');
  return (
    <section className="panel tests-panel" id="tests" aria-labelledby="tests-title">
      <header className="panel-header">
        <h2 id="tests-title">
          <FlaskConical size={15} />
          Test results
        </h2>
        <span
          className={`test-summary ${failed ? 'text-danger' : results.length ? 'text-success' : ''}`}
        >
          {passed} / {results.length} passing
        </span>
      </header>
      <div className="test-list">
        {!results.length && (
          <div className="empty-state">
            <FlaskConical size={23} />
            <strong>{mode === 'demo' ? 'Tests are up next' : 'No test results reported'}</strong>
            <p>{mode === 'demo' ? 'Follow failures, fixes, and the final green run.' : 'Your connected agent can report the tests it runs.'}</p>
          </div>
        )}
        {results.map((test) => (
          <div
            className={`test-row ${test.status}`}
            key={test.name}
            data-testid={`test-${test.name}`}
            data-status={test.status}
          >
            <div className="test-row-main">
              <StatusIcon status={test.status} />
              <code>{test.name}</code>
              <span className="test-attempt">#{test.attempt}</span>
            </div>
            {mode === 'live' && <span className={`event-source source-${test.source ?? 'agent'}`}>{sourceLabel(test.source)}</span>}
            {test.details && <p>{test.details}</p>}
          </div>
        ))}
        {results.length > 0 && (
          <div className="test-footnote">
            <span className={`status-dot ${failed ? 'danger' : ''}`} />
            {failed
              ? mode === 'demo' ? 'The agent will investigate this failure.' : 'The latest report includes a failing test.'
              : results.every((test) => test.status === 'passed')
                ? mode === 'demo' ? 'All observed tests are passing.' : 'All reported tests are passing.'
                : 'Test suite is running…'}
          </div>
        )}
      </div>
    </section>
  );
}
