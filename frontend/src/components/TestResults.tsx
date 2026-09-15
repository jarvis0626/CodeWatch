import { FlaskConical } from 'lucide-react';
import type { TestResult } from '../types/events';
import { StatusIcon } from './StatusIcon';

export function TestResults({ tests }: { tests: Record<string, TestResult> }) {
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
            <strong>Tests are up next</strong>
            <p>Follow failures, fixes, and the final green run.</p>
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
            {test.details && <p>{test.details}</p>}
          </div>
        ))}
        {results.length > 0 && (
          <div className="test-footnote">
            <span className={`status-dot ${failed ? 'danger' : ''}`} />
            {failed
              ? 'The agent will investigate this failure.'
              : results.every((test) => test.status === 'passed')
                ? 'All observed tests are passing.'
                : 'Test suite is running…'}
          </div>
        )}
      </div>
    </section>
  );
}
