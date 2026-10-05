import { describe, expect, it } from 'vitest';
import type { FileChange, GraphEdge, GraphNode } from '../types/events';
import { fileLinks, folderConnections, indexedFiles, projectAreas, recentChanges } from './projectMap';

const file = (path: string): GraphNode => ({ id: `file:${path}`, path, label: path.split('/').at(-1)!, kind: 'module', state: 'completed', message: 'Indexed file' });
const edge = (source: GraphNode, target: GraphNode, evidence: GraphEdge['evidence'] = 'import'): GraphEdge => ({ id: `${source.id}:${target.id}:${evidence}`, source: source.id, target: target.id, evidence, label: 'imports', message: 'Observed import' });
const changed = (path: string, kind: FileChange['kind'] = 'modified'): FileChange => ({ eventId: `event:${path}:${kind}`, path, kind, timestamp: '2026-10-05T10:00:00Z', source: 'filesystem' });

describe('readable project map', () => {
  it('groups a large repository into its actual folders and excludes the agent from file counts', () => {
    const files = Array.from({ length: 90 }, (_, index) => file(`${index < 60 ? 'frontend' : 'backend'}/src/file-${index}.ts`));
    const indexed = indexedFiles([...files, { id: 'agent', label: 'Agent', kind: 'agent', state: 'active', message: 'Working' }]);
    const areas = projectAreas(indexed, [], [changed(files[0].path!)], null);
    expect(indexed).toHaveLength(90);
    expect(areas.map((area) => [area.path, area.files.length, area.changed])).toEqual([['backend', 30, 0], ['frontend', 60, 1]]);
    expect(indexed.every((node) => node.state === 'completed')).toBe(true);
  });

  it('drills into one folder without matching a folder that merely shares its prefix', () => {
    const nodes = [file('src/App.tsx'), file('src/ui/Form.tsx'), file('src/ui/Button.tsx'), file('src-extra/other.ts')];
    expect(projectAreas(nodes, [], [], 'src').map((area) => [area.path, area.files.length])).toEqual([['src/ui', 2]]);
    expect(projectAreas(nodes, [], [], null).map((area) => area.path)).toEqual(['src', 'src-extra']);
  });

  it('keeps project-root files in a named area', () => {
    const root = file('pyproject.toml');
    const areas = projectAreas([root, file('backend/main.py')], [], [], null);
    expect(areas[0]).toMatchObject({ path: '', label: 'Project root', files: [root] });
    expect(projectAreas([root], [], [], '')).toEqual([]);
  });

  it('describes the observed import direction and keeps agent-reported links separate', () => {
    const app = file('frontend/App.tsx');
    const data = file('backend/data.py');
    const links = [edge(app, data), { ...edge(data, app, 'reported'), label: 'serves', message: 'Agent supplied relationship' }];
    const areas = projectAreas([app, data], links, [], null);
    expect(folderConnections(areas, links).map((link) => [link.source.path, link.target.path, link.evidence, link.count])).toEqual([
      ['frontend', 'backend', 'import', 1], ['backend', 'frontend', 'reported', 1],
    ]);
    expect(fileLinks(app.id, [app, data], links).map((link) => [link.file.path, link.outgoing, link.edge.evidence])).toEqual([
      ['backend/data.py', true, 'import'], ['backend/data.py', false, 'reported'],
    ]);
  });

  it('never invents folder connections, counts unverified edges as imports, or displays removed neighbors', () => {
    const app = file('frontend/App.tsx');
    const data = file('backend/data.py');
    const unknown = { ...edge(app, data), evidence: undefined };
    const areas = projectAreas([app, data], [unknown], [], null);
    expect(folderConnections(areas, [unknown])).toEqual([]);
    expect(fileLinks(app.id, [app, data], [unknown])).toEqual([]);
    expect(folderConnections(areas, [])).toEqual([]);
    expect(fileLinks(app.id, [app], [edge(app, data)])).toEqual([]);
  });

  it('keeps one recent entry per file and preserves the latest deletion instead of showing stale activity', () => {
    const latest = [changed('src/a.ts', 'deleted'), changed('src/a.ts'), changed('src/b.ts'), changed('src/c.ts')];
    expect(recentChanges(latest, 2).map((change) => [change.path, change.kind])).toEqual([['src/a.ts', 'deleted'], ['src/b.ts', 'modified']]);
    expect(projectAreas([file('src/a.ts'), file('src/b.ts')], [], latest.slice(0, 1), null)[0].changed).toBe(0);
  });
});
