import { memo, useEffect, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
} from '@xyflow/react';
import type { Node, NodeProps } from '@xyflow/react';
import {
  Bot,
  Box,
  Boxes,
  Braces,
  Database,
  FileCode2,
  FlaskConical,
  Layers3,
  Maximize,
  Network,
  Radio,
  Search,
  X,
} from 'lucide-react';
import type { GraphEdge, GraphNode, NodeKind } from '../types/events';
import { StatusIcon } from './StatusIcon';
import { ProjectMap } from './ProjectMap';
import type { FileChange } from '../types/events';

type ArchitectureNode = Node<GraphNode, 'architecture'>;
const icons = {
  agent: Bot,
  frontend: Braces,
  api: Network,
  service: Box,
  repository: Layers3,
  database: Database,
  test: FlaskConical,
  module: FileCode2,
  config: Braces,
  style: Layers3,
};
const typeLabels = {
  agent: 'ORCHESTRATOR',
  frontend: 'FRONTEND',
  api: 'API LAYER',
  service: 'SERVICE',
  repository: 'REPOSITORY',
  database: 'DATABASE',
  test: 'TESTS',
  module: 'MODULE',
  config: 'CONFIGURATION',
  style: 'STYLES',
};
const positions: Record<NodeKind, { x: number; y: number }> = {
  agent: { x: -210, y: 0 },
  frontend: { x: 70, y: 0 },
  api: { x: 70, y: 122 },
  service: { x: 70, y: 244 },
  repository: { x: -75, y: 366 },
  test: { x: 220, y: 366 },
  database: { x: -75, y: 488 },
  module: { x: 490, y: 0 },
  config: { x: 490, y: 122 },
  style: { x: 490, y: 244 },
};

const GraphCard = memo(function GraphCard({ data, selected }: NodeProps<ArchitectureNode>) {
  const Icon = icons[data.kind];
  return (
    <div
      className={`graph-node kind-${data.kind} node-${data.state} ${selected ? 'node-selected' : ''}`}
      data-testid={`node-${data.id}`}
      data-state={data.state}
    >
      <Handle type="target" position={Position.Top} id="top" />
      <Handle type="target" position={Position.Left} id="left" />
      <div className="node-heading">
        <span className="node-icon">
          <Icon size={17} />
        </span>
        <span className="node-kind">{typeLabels[data.kind]}</span>
        <StatusIcon status={data.state} size={13} />
      </div>
      <div className="node-title" title={data.label}>{data.label}</div>
      <div className="node-subtitle">
        {data.kind === 'agent' ? data.description ?? 'Coding assistant' : data.path?.split('/').at(-1)}
      </div>
      <Handle type="source" position={Position.Bottom} id="bottom" />
      <Handle type="source" position={Position.Right} id="right" />
    </div>
  );
});
const nodeTypes = { architecture: GraphCard };

function ViewportManager({ count }: { count: number }) {
  const { fitView } = useReactFlow();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  useEffect(() => {
    const id = setTimeout(() => {
      void fitView({ padding: 0.22, maxZoom: 1, duration: 250 });
    }, 80);
    return () => clearTimeout(id);
  }, [count, fitView, width, height]);
  return null;
}

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  live: boolean;
  runId: string | null;
  projectName?: string;
  mode: 'live' | 'demo';
  files?: FileChange[];
  focusRequest?: { path: string } | null;
}

function Graph({ nodes, edges, live, runId, projectName, mode }: Props) {
  const { fitView } = useReactFlow();
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');
  const [focus, setFocus] = useState(false);
  const selectedNode = nodes.find((node) => node.id === selected);
  const connectedIds = useMemo(() => {
    const ids = new Set([selected]);
    edges.forEach((edge) => { if (edge.source === selected || edge.target === selected) { ids.add(edge.source); ids.add(edge.target); } });
    return ids;
  }, [edges, selected]);
  const matches = useMemo(() => nodes.filter((node) => (!focus || !selected || connectedIds.has(node.id)) && (kind === 'all' || node.kind === kind) && `${node.label} ${node.path ?? ''}`.toLowerCase().includes(query.toLowerCase())), [nodes, focus, selected, connectedIds, kind, query]);
  const visible = useMemo(() => mode === 'demo' ? nodes : [...matches]
    .sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active'))
    .slice(0, 80)
    .sort((a, b) => a.kind.localeCompare(b.kind) || (a.path ?? a.label).localeCompare(b.path ?? b.label)), [nodes, mode, matches]);
  const flowNodes = useMemo(() => {
    const counts: Partial<Record<NodeKind, number>> = {};
    const kinds = [...new Set(visible.map((node) => node.kind))];
    let baseX = 0;
    const offsets = new Map(kinds.map((value) => { const x = baseX; baseX += Math.max(1, Math.ceil(visible.filter((node) => node.kind === value).length / 8)) * 260; return [value, x]; }));
    return visible.map((node): ArchitectureNode => {
      const offset = counts[node.kind] ?? 0;
      counts[node.kind] = offset + 1;
      return {
        id: node.id,
        type: 'architecture',
        position: mode === 'demo' ? { ...positions[node.kind], x: positions[node.kind].x + offset * 250 } : { x: offsets.get(node.kind)! + Math.floor(offset / 8) * 260, y: (offset % 8) * 142 },
        data: node,
        selected: node.id === selected,
      };
    });
  }, [visible, mode, selected]);
  const flowEdges = useMemo(
    () =>
      edges
        .filter(
          (edge) =>
            visible.some((node) => node.id === edge.source) &&
            visible.some((node) => node.id === edge.target),
        )
        .map((edge) => {
          const active = nodes.find((node) => node.id === edge.target)?.state === 'active';
          const fromAgent = nodes.find((node) => node.id === edge.source)?.kind === 'agent';
          return {
            ...edge,
            sourceHandle: fromAgent || mode === 'live' ? 'right' : 'bottom',
            targetHandle: fromAgent || mode === 'live' ? 'left' : 'top',
            type: 'smoothstep',
            animated: active && live,
            style: { stroke: edge.evidence === 'reported' ? '#b5a7d4' : active ? '#a6e8c8' : '#52695c', strokeWidth: 1.3, strokeDasharray: edge.evidence === 'reported' ? '5 4' : undefined },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: active ? '#a6e8c8' : '#59625f',
              width: 15,
              height: 15,
            },
            labelStyle: { fill: '#818d87', fontSize: 10 },
            labelBgStyle: { fill: '#121615' },
            labelBgPadding: [5, 3] as [number, number],
          };
        }),
    [edges, nodes, visible, live, mode],
  );

  return (
    <section
      className="panel architecture-panel"
      id="architecture"
      aria-labelledby="architecture-title"
    >
      <header className="panel-header">
        <h2 id="architecture-title">
          <Boxes size={16} />
          Live architecture
        </h2>
        <div className="panel-header-right">
          <span className={`live-label ${live ? 'is-live' : ''}`}>
            <span className="status-dot" />
            {live ? 'LIVE' : 'CANVAS'}
          </span>
          <button
            className="icon-button"
            title="Fit graph to view"
            aria-label="Fit graph to view"
            onClick={() => {
              void fitView({ padding: 0.22, maxZoom: 1, duration: 250 });
            }}
          >
            <Maximize size={14} />
          </button>
        </div>
      </header>
      {mode === 'live' && <div className="graph-toolbar"><label><Search size={12} /><input aria-label="Search architecture" placeholder="Find a file or component…" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="Filter architecture kind" value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">All layers</option>{Object.entries(typeLabels).map(([value, label]) => <option value={value} key={value}>{label.toLowerCase()}</option>)}</select><button className={`button reset-button ${focus ? 'focus-active' : ''}`} disabled={!selectedNode} aria-pressed={focus} onClick={() => setFocus(!focus)}>Focus connections</button></div>}
      <div className="graph-canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.22 }}
          minZoom={0.03}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          deleteKeyCode={null}
          colorMode="dark"
          onNodeClick={(_, node) => setSelected(node.id)}
          onPaneClick={() => { setSelected(null); setFocus(false); }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#303734" />
          <Controls showInteractive={false} />
          <ViewportManager count={visible.length} />
          <Panel position="top-left" className="canvas-label">
            <Radio size={12} />
            {runId ? `${projectName ?? 'project'} / ${visible.length} of ${nodes.length} nodes` : mode === 'demo' ? 'Awaiting first build' : 'Awaiting a project'}
          </Panel>
          {!runId && (
            <Panel position="bottom-center" className="graph-empty">
              <span className="empty-overline">EVERY BUILD TELLS A STORY</span>
              <strong>Watch yours unfold.</strong>
              <p>
                {mode === 'demo' ? 'Start a build to see files, services, and connections' : 'Connect your project to see its files and dependencies'}
                <br />
                come together in real time.
              </p>
            </Panel>
          )}
          {selectedNode && (
            <Panel position="top-right" className="node-inspector">
              <button
                aria-label="Close node details"
                className="icon-button"
                onClick={() => { setSelected(null); setFocus(false); }}
              >
                <X size={13} />
              </button>
              <span className="eyebrow">{selectedNode.kind}</span>
              <strong>{selectedNode.label}</strong>
              <span className={`badge ${selectedNode.state}`}>{selectedNode.state}</span>
              {selectedNode.path && (
                <code>
                  <FileCode2 size={12} />
                  {selectedNode.path}
                </code>
              )}
              <p>{selectedNode.message}</p>
              {selectedNode.description && <p>{selectedNode.description}</p>}
              {mode === 'live' && (
                <div className="node-connections">
                  <span className="eyebrow">CONNECTIONS</span>
                  <ul className="connection-list">
                    {edges
                      .filter((edge) => edge.source === selected || edge.target === selected)
                      .slice(0, 12)
                      .map((edge) => {
                        const outgoing = edge.source === selected;
                        const neighborId = outgoing ? edge.target : edge.source;
                        const neighbor = nodes.find((node) => node.id === neighborId);
                        const reported = edge.evidence === 'reported';
                        return (
                          <li className="connection-entry" key={edge.id}>
                            <span className={`event-source ${reported ? 'source-agent' : 'source-filesystem'}`}>
                              {reported ? 'Agent-reported' : 'Import'}
                            </span>
                            <span className="connection-direction">
                              {outgoing ? 'Outgoing to →' : 'Incoming from ←'}
                            </span>
                            <code>{neighbor?.path ?? neighbor?.label ?? neighborId}</code>
                            <strong className="connection-relation">{edge.label}</strong>
                            {reported && edge.message && <p>{edge.message}</p>}
                          </li>
                        );
                      })}
                  </ul>
                </div>
              )}
            </Panel>
          )}
        </ReactFlow>
      </div>
      <footer className="graph-footer">
        <div className="graph-legend">
          {(['planned', 'active', 'completed', 'failed'] as const).map((status) => (
            <span key={status}>
              <i className={`legend-dot ${status}`} />
              {mode === 'live' && status === 'completed' ? 'indexed / settled' : status}
            </span>
          ))}
        </div>
        <span className="graph-hint">{mode === 'live' ? 'Solid: imports · Dashed: reported flow' : 'Scroll to zoom · Drag to pan'}</span>
      </footer>
      {mode === 'live' && <div className="graph-evidence-note">{matches.length > 80 ? `Showing 80 of ${matches.length} matching nodes. Search or select a layer to narrow the map. ` : ''}Imports are code dependencies; agent-reported flow is shown with dashed lines.</div>}
    </section>
  );
}

export function ArchitectureGraph(props: Props) {
  if (props.mode === 'live') return <ProjectMap {...props} />;
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
