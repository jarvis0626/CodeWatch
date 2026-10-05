import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow } from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import { ArrowLeft, ArrowRight, ChevronRight, FileCode2, Folder, FolderOpen, GitBranch, Maximize, Search } from 'lucide-react';
import type { FileChange, GraphEdge, GraphNode } from '../types/events';
import { fileLinks, folderConnections, indexedFiles, inFolder, projectAreas, recentChanges } from '../state/projectMap';
import type { FileLink } from '../state/projectMap';

export interface ProjectMapProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  files?: FileChange[];
  live: boolean;
  runId: string | null;
  projectName?: string;
  focusRequest?: { path: string } | null;
}

type FileNode = Node<GraphNode & { center: boolean }, 'file'>;
const FileCard = memo(function FileCard({ data }: NodeProps<FileNode>) {
  return <div className={`connection-node ${data.center ? 'connection-selected' : ''}`} data-testid={`node-${data.id}`}>
    <Handle type="target" position={Position.Left} />
    <span><FileCode2 size={14} />{data.center ? 'Selected file' : 'Connected file'}</span>
    <strong>{data.label}</strong>
    <small title={data.path ?? ''}>{data.path}</small>
    <Handle type="source" position={Position.Right} />
  </div>;
});
const nodeTypes = { file: FileCard };

function FitSelection({ id }: { id: string }) {
  const ready = useNodesInitialized();
  const { fitView } = useReactFlow();
  const fitted = useRef<string | null>(null);
  useEffect(() => {
    if (!ready || fitted.current === id) return;
    fitted.current = id;
    void fitView({ padding: 0.15, minZoom: 0.65, maxZoom: 1, duration: 0 });
  }, [ready, id, fitView]);
  return null;
}

function Neighborhood({ selected, links, onSelect }: { selected: GraphNode; links: FileLink[]; onSelect: (id: string) => void }) {
  const { fitView } = useReactFlow();
  // Slots belong to the selected file; saves and unrelated files never reposition them.
  const positions = useRef({ selected: selected.id, slots: new Map<string, { x: number; y: number }>() });
  if (positions.current.selected !== selected.id) positions.current = { selected: selected.id, slots: new Map() };
  const neighbors: GraphNode[] = [];
  for (const outgoing of [false, true]) {
    const distinct = [...new Map(links.filter((link) => link.outgoing === outgoing && link.file.id !== selected.id)
      .map((link) => [link.file.id, link.file])).values()];
    distinct.sort((a, b) => Number(positions.current.slots.has(b.id)) - Number(positions.current.slots.has(a.id)));
    const visible = distinct.slice(0, 3);
    const x = outgoing ? 530 : 0;
    for (const [index, file] of visible.entries()) {
      if (neighbors.some((neighbor) => neighbor.id === file.id)) continue;
      neighbors.push(file);
      if (!positions.current.slots.has(file.id)) {
        const occupied = new Set([...positions.current.slots.values()].filter((position) => position.x === x).map((position) => position.y));
        const y = [0, 112, 224].find((slot) => !occupied.has(slot)) ?? index * 112;
        positions.current.slots.set(file.id, { x, y });
      }
    }
  }
  const diagramNodes: FileNode[] = [selected, ...neighbors].map((file) => ({
    id: file.id, type: 'file', position: file.id === selected.id ? { x: 265, y: 112 } : positions.current.slots.get(file.id)!,
    data: { ...file, center: file.id === selected.id },
  }));
  const visibleIds = new Set(diagramNodes.map((node) => node.id));
  const diagramEdges = links.filter(({ edge }) => visibleIds.has(edge.source) && visibleIds.has(edge.target)).map(({ edge }) => ({
    ...edge, type: 'smoothstep', animated: false,
    label: edge.evidence === 'import' ? 'imports' : edge.label,
    style: { stroke: edge.evidence === 'reported' ? '#b5a7d4' : '#95c8ad', strokeDasharray: edge.evidence === 'reported' ? '5 4' : undefined },
    labelStyle: { fontSize: 11, fill: '#b5cbbd' }, labelBgStyle: { fill: '#121615' },
    markerEnd: { type: MarkerType.ArrowClosed, color: '#95c8ad' },
  }));
  return <div className="focused-diagram-wrap">
    <div className="focused-diagram-toolbar"><span>Selected file and its nearest connections</span><button type="button" className="button reset-button" aria-label="Fit file connections" onClick={() => void fitView({ padding: 0.15, minZoom: 0.65, maxZoom: 1 })}><Maximize size={13} />Recenter</button></div>
    <div className="focused-diagram" data-testid="file-connections-diagram">
      <ReactFlow nodes={diagramNodes} edges={diagramEdges} nodeTypes={nodeTypes} minZoom={0.4} maxZoom={1.5}
        nodesDraggable={false} nodesConnectable={false} deleteKeyCode={null} colorMode="dark"
        onNodeClick={(_, node) => onSelect(node.id)}>
        <Background gap={22} color="#303734" /><Controls showInteractive={false} /><FitSelection id={selected.id} />
      </ReactFlow>
    </div>
    {new Set(links.map((link) => link.file.id)).size > neighbors.length && <p className="map-note">The diagram shows up to three neighbors on each side. Every connection remains available in the lists above.</p>}
  </div>;
}

function ConnectionList({ title, links, onSelect }: { title: string; links: FileLink[]; onSelect: (id: string) => void }) {
  return <section className="map-connection-column"><h4>{title}<span>{links.length}</span></h4>
    {links.length ? <ul>{links.map(({ edge, file }) => <li key={edge.id}>
      <button type="button" onClick={() => onSelect(file.id)} title={file.path!}><FileCode2 size={14} /><span><strong>{file.label}</strong><small>{file.path}</small></span><ChevronRight size={13} /></button>
    </li>)}</ul> : <p>No direct local imports detected.</p>}
  </section>;
}

export function ProjectMap({ nodes, edges, files: changes = [], live, runId, projectName, focusRequest }: ProjectMapProps) {
  const files = useMemo(() => indexedFiles(nodes), [nodes]);
  const [folder, setFolder] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [diagram, setDiagram] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [notice, setNotice] = useState('');
  const consumed = useRef<ProjectMapProps['focusRequest']>(null);
  const selected = files.find((file) => file.id === selectedId);
  useEffect(() => {
    if (!focusRequest || consumed.current === focusRequest) return;
    consumed.current = focusRequest;
    setHidden(false);
    const file = files.find((entry) => entry.path === focusRequest.path);
    if (file) { setSelectedId(file.id); setNotice(''); }
    else setNotice(`${focusRequest.path} is no longer in the indexed project map. Its recorded change remains in File changes.`);
  }, [focusRequest, files]);
  const areas = useMemo(() => projectAreas(files, edges, changes, folder), [files, edges, changes, folder]);
  const connections = useMemo(() => folderConnections(areas, edges), [areas, edges]);
  const latest = useMemo(() => recentChanges(changes), [changes]);
  const links = selected ? fileLinks(selected.id, files, edges) : [];
  const filtered = files.filter((file) => `${file.label} ${file.path}`.toLowerCase().includes(query.toLowerCase()) && (kind === 'all' || file.kind === kind));
  const searching = !!query.trim() || kind !== 'all';
  const listed = searching ? filtered : folder === null ? [] : files.filter((file) => inFolder(file.path!, folder) && !file.path!.slice(folder ? folder.length + 1 : 0).includes('/'));
  const changedPaths = new Set(changes.map((change) => change.path));
  function select(id: string) { setSelectedId(id); setNotice(''); }
  function openFolder(path: string | null) { setFolder(path); setSelectedId(null); setQuery(''); setKind('all'); setNotice(''); }
  function selectChange(change: FileChange) {
    const file = files.find((entry) => entry.path === change.path);
    if (file) select(file.id);
    else { setSelectedId(null); setNotice(`${change.path} was deleted. It is no longer in the project map.`); }
  }
  return <section className="panel architecture-panel project-map" id="architecture" aria-labelledby="architecture-title">
    <header className="panel-header"><h2 id="architecture-title"><FolderOpen size={16} />Project map</h2>
      <div className="panel-header-right"><span className={`live-label ${live ? 'is-live' : ''}`}><span className="status-dot" />{live ? 'WATCHING' : 'PROJECT'}</span>
        <button type="button" className="button reset-button map-hide-button" aria-expanded={!hidden} aria-controls="project-map-content" onClick={() => setHidden(!hidden)}>{hidden ? 'Show map' : 'Hide map'}</button>
      </div>
    </header>
    <div className="project-map-content" id="project-map-content" hidden={hidden}>
      <div className="map-introduction"><strong>Understand where a change fits.</strong><p>Open a folder or pick a file to see what it uses and what uses it.</p></div>
      {!!latest.length && <div className="map-recent"><span className="eyebrow">RECENT FILE CHANGES</span><div>{latest.map((change) => <button type="button" key={change.path} onClick={() => selectChange(change)} title={change.path}><span className={`map-change-dot ${change.kind}`} /><span>{change.path.split('/').at(-1)}</span><small>{change.kind === 'deleted' ? 'deleted' : 'view connections'}</small></button>)}</div></div>}
      <div className="graph-toolbar map-search"><label><Search size={14} /><input aria-label="Search architecture" placeholder="Find a file by name or path" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <select aria-label="Filter architecture kind" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All file types</option>{[...new Set(files.map((file) => file.kind))].sort().map((value) => <option value={value} key={value}>{value}</option>)}</select>
      </div>
      {notice && <p className="map-notice" role="status">{notice}</p>}
      {selected ? <div className="map-file-details" data-testid="map-file-details">
        <button className="button reset-button map-back" type="button" onClick={() => setSelectedId(null)}><ArrowLeft size={14} />Back to {folder === null ? 'project' : 'folder'}</button>
        <div className="map-selected-heading"><FileCode2 size={23} /><div><h3>{selected.label}</h3><code>{selected.path}</code></div><span className="map-file-status">{changedPaths.has(selected.path!) ? 'Changed this session' : 'Indexed file'}</span></div>
        <p className="map-explanation">Import connections show code this file uses and files that use it. They do not show the order code runs.</p>
        <div className="map-connection-lists">
          <ConnectionList title="Uses code from" links={links.filter(({ edge, outgoing }) => edge.evidence === 'import' && outgoing)} onSelect={select} />
          <ConnectionList title="Used by" links={links.filter(({ edge, outgoing }) => edge.evidence === 'import' && !outgoing)} onSelect={select} />
        </div>
        {!!links.filter(({ edge }) => edge.evidence === 'reported').length && <section className="map-reported"><h4>Agent-reported connections</h4>{links.filter(({ edge }) => edge.evidence === 'reported').map(({ edge, file, outgoing }) => <div key={edge.id}><button type="button" onClick={() => select(file.id)}>{outgoing ? `${selected.label} → ${file.label}` : `${file.label} → ${selected.label}`}<ChevronRight size={13} /></button><strong>{edge.label}</strong><p>{edge.message}</p></div>)}</section>}
        <button className="button reset-button diagram-toggle" type="button" aria-pressed={diagram} onClick={() => setDiagram(!diagram)}><GitBranch size={14} />{diagram ? 'Hide connection diagram' : 'Show connection diagram'}</button>
        {diagram && <ReactFlowProvider><Neighborhood selected={selected} links={links} onSelect={select} /></ReactFlowProvider>}
      </div> : <div className="map-overview">
        <nav className="map-breadcrumbs" aria-label="Folder navigation"><button type="button" onClick={() => openFolder(null)}>{projectName ?? 'Project'}</button>{folder !== null && (folder ? folder.split('/').map((part, index, parts) => <span key={index}><ChevronRight size={12} /><button type="button" onClick={() => openFolder(parts.slice(0, index + 1).join('/'))}>{part}</button></span>) : <span><ChevronRight size={12} />Project root</span>)}</nav>
        {searching ? <p className="map-note">{filtered.length} matching {filtered.length === 1 ? 'file' : 'files'} across the project</p> : <>
          <div className="project-areas" data-testid="project-areas">{areas.map((area) => <button type="button" className={`project-area ${area.changed ? 'area-changed' : ''}`} key={area.path} aria-label={`Open ${area.path || 'project root'} folder`} onClick={() => openFolder(area.path)}>
            <div className="area-heading"><Folder size={20} /><h3>{area.label}</h3><ChevronRight size={16} /></div>
            <p>{area.files.length} {area.files.length === 1 ? 'file' : 'files'}<span>{area.internalImports} internal {area.internalImports === 1 ? 'import' : 'imports'}</span></p>
            <div className="area-path">{area.path || 'Files beside your project folders'}</div>
            <span className="area-change-label">{area.changed ? `${area.changed} changed this session` : 'No saved changes this session'}</span>
          </button>)}</div>
          {!!connections.length && <div className="area-connections"><h4>Connections between these folders</h4>{connections.map((connection) => <p key={`${connection.source.path}:${connection.target.path}:${connection.evidence}`}><button type="button" onClick={() => openFolder(connection.source.path)}>{connection.source.label}</button><ArrowRight size={14} /><button type="button" onClick={() => openFolder(connection.target.path)}>{connection.target.label}</button><span>{connection.count} {connection.evidence === 'import' ? 'imports' : 'agent-reported links'}</span></p>)}</div>}
        </>}
        {!!listed.length && <div className="map-file-list"><h4>{searching ? 'Search results' : 'Files in this folder'}</h4>{listed.slice(0, 100).map((file) => <button type="button" key={file.id} data-testid={`map-file-${file.id}`} data-state={file.state} aria-label={`Open connections for ${file.path}`} onClick={() => select(file.id)}><FileCode2 size={16} /><span><strong>{file.label}</strong><small>{file.path}</small></span>{changedPaths.has(file.path!) && <span className="map-file-changed">Changed</span>}<ChevronRight size={14} /></button>)}{listed.length > 100 && <p className="map-note">Showing 100 of {listed.length} files. Search for a name to narrow the list.</p>}</div>}
        {searching && !listed.length && <p className="map-empty">No matching files. Try a different name or file type.</p>}
        {!files.length && <div className="map-empty"><FolderOpen size={28} /><strong>{runId ? 'No supported source files found' : 'Choose a project to see its structure'}</strong><p>{runId ? 'Check the scan warnings above, or choose a folder containing source files.' : 'Your folders will appear here. Saved changes will point you to the relevant files.'}</p></div>}
      </div>}
      <p className="map-evidence">Folder names come from your project. Connections come from local imports or explicit agent reports. A mapped file does not mean its feature is complete.</p>
    </div>
  </section>;
}
