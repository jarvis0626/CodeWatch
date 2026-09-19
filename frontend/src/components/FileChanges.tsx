import { FileCode2, Files } from 'lucide-react';
import { sourceLabel, type FileChange } from '../types/events';

export function FileChanges({ files }: { files: FileChange[] }) {
  return (
    <section className="panel file-panel" id="files" aria-labelledby="files-title">
      <header className="panel-header">
        <h2 id="files-title">
          <Files size={15} />
          File changes<span className="count-badge">{files.length}</span>
        </h2>
        <span className="tiny-label">NEWEST FIRST</span>
      </header>
      <div className="file-list">
        {!files.length && (
          <div className="empty-state">
            <FileCode2 size={23} />
            <strong>A clean slate</strong>
            <p>Created, modified, and deleted files will appear here.</p>
          </div>
        )}
        {files.map((file) => {
          const parts = file.path.split('/');
          const name = parts.pop();
          return (
            <div className={`file-row ${file.kind}`} key={file.eventId}>
              <span className="file-operation" aria-label={file.kind}>
                {file.kind === 'created' ? '+' : file.kind === 'deleted' ? '−' : '~'}
              </span>
              <FileCode2 size={14} />
              <div title={file.path}>
                <span>{name}</span>
                <small>{parts.join('/')}/ · {sourceLabel(file.source, !file.source)}</small>
              </div>
              <span className="file-kind">{file.kind === 'created' ? 'NEW' : file.kind === 'deleted' ? 'DELETED' : 'EDIT'}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
