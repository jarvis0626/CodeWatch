import type { FileChange, GraphEdge, GraphNode } from '../types/events';

export interface ProjectArea {
  path: string;
  label: string;
  files: GraphNode[];
  changed: number;
  internalImports: number;
}

export function indexedFiles(nodes: GraphNode[]): GraphNode[] {
  return nodes.filter((node) => node.kind !== 'agent' && !!node.path)
    .sort((a, b) => a.path!.localeCompare(b.path!));
}

export function inFolder(path: string, folder: string): boolean {
  return folder === '' ? !path.includes('/') : path.startsWith(folder + '/');
}

export function projectAreas(files: GraphNode[], edges: GraphEdge[], changes: FileChange[], folder: string | null): ProjectArea[] {
  const groups = new Map<string, GraphNode[]>();
  const changed = new Set(changes.filter((change) => change.kind !== 'deleted').map((change) => change.path));
  for (const file of files) {
    const path = file.path!;
    if (folder !== null && !inFolder(path, folder)) continue;
    const remainder = folder === null ? path : path.slice(folder.length + 1);
    if (folder !== null && !remainder.includes('/')) continue;
    const area = remainder.includes('/') ? [folder, remainder.split('/')[0]].filter(Boolean).join('/') : '';
    groups.set(area, [...(groups.get(area) ?? []), file]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([path, members]) => {
    const ids = new Set(members.map((file) => file.id));
    return {
      path, label: path ? path.split('/').at(-1)! : 'Project root', files: members,
      changed: members.filter((file) => changed.has(file.path!)).length,
      internalImports: edges.filter((edge) => edge.evidence === 'import' && ids.has(edge.source) && ids.has(edge.target)).length,
    };
  });
}

export interface FileLink { edge: GraphEdge; file: GraphNode; outgoing: boolean }
export function fileLinks(id: string, files: GraphNode[], edges: GraphEdge[]): FileLink[] {
  const lookup = new Map(files.map((file) => [file.id, file]));
  return edges.flatMap((edge): FileLink[] => {
    if (edge.evidence !== 'import' && edge.evidence !== 'reported') return [];
    if (edge.source !== id && edge.target !== id) return [];
    const outgoing = edge.source === id;
    const file = lookup.get(outgoing ? edge.target : edge.source);
    return file ? [{ edge, file, outgoing }] : [];
  });
}

export function recentChanges(changes: FileChange[], limit = 4): FileChange[] {
  const distinct = new Map<string, FileChange>();
  // Reducer stores changes newest first. A deleted file remains an observed deletion.
  for (const change of changes) if (!distinct.has(change.path)) distinct.set(change.path, change);
  return [...distinct.values()].slice(0, limit);
}

export function folderConnections(areas: ProjectArea[], edges: GraphEdge[]) {
  const areaByFile = new Map(areas.flatMap((area) => area.files.map((file) => [file.id, area] as const)));
  const connections = new Map<string, { source: ProjectArea; target: ProjectArea; evidence: 'import' | 'reported'; count: number }>();
  for (const edge of edges) {
    const source = areaByFile.get(edge.source);
    const target = areaByFile.get(edge.target);
    if (!source || !target || source === target || (edge.evidence !== 'import' && edge.evidence !== 'reported')) continue;
    const key = JSON.stringify([source.path, target.path, edge.evidence]);
    const entry = connections.get(key) ?? { source, target, evidence: edge.evidence, count: 0 };
    entry.count++;
    connections.set(key, entry);
  }
  return [...connections.values()];
}
