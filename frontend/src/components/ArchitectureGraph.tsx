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
  X,
} from 'lucide-react';
import type { GraphEdge, GraphNode, NodeKind } from '../types/events';
import { StatusIcon } from './StatusIcon';

type ArchitectureNode = Node<GraphNode, 'architecture'>;
const icons = {
  agent: Bot,
  frontend: Braces,
  api: Network,
  service: Box,
  repository: Layers3,
  database: Database,
  test: FlaskConical,
};
const typeLabels = {
  agent: 'ORCHESTRATOR',
  frontend: 'FRONTEND',
  api: 'API LAYER',
  service: 'SERVICE',
  repository: 'REPOSITORY',
  database: 'DATABASE',
  test: 'TESTS',
};
const positions: Record<NodeKind, { x: number; y: number }> = {
  agent: { x: -210, y: 0 },
  frontend: { x: 70, y: 0 },
  api: { x: 70, y: 122 },
  service: { x: 70, y: 244 },
  repository: { x: -75, y: 366 },
  test: { x: 220, y: 366 },
  database: { x: -75, y: 488 },
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
      <div className="node-title">{data.label}</div>
      <div className="node-subtitle">
        {data.kind === 'agent' ? 'Simulated coding agent' : data.path?.split('/').at(-1)}
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
}

function Graph({ nodes, edges, live, runId }: Props) {
  const { fitView } = useReactFlow();
  const [selected, setSelected] = useState<string | null>(null);
  const selectedNode = nodes.find((node) => node.id === selected);
  const flowNodes = useMemo(() => {
    const counts: Partial<Record<NodeKind, number>> = {};
    return nodes.map((node): ArchitectureNode => {
      const offset = counts[node.kind] ?? 0;
      counts[node.kind] = offset + 1;
      return {
        id: node.id,
        type: 'architecture',
        position: { ...positions[node.kind], x: positions[node.kind].x + offset * 250 },
        data: node,
      };
    });
  }, [nodes]);
  const flowEdges = useMemo(
    () =>
      edges
        .filter(
          (edge) =>
            nodes.some((node) => node.id === edge.source) &&
            nodes.some((node) => node.id === edge.target),
        )
        .map((edge) => {
          const active = nodes.find((node) => node.id === edge.target)?.state === 'active';
          const fromAgent = nodes.find((node) => node.id === edge.source)?.kind === 'agent';
          return {
            ...edge,
            sourceHandle: fromAgent ? 'right' : 'bottom',
            targetHandle: fromAgent ? 'left' : 'top',
            type: 'smoothstep',
            animated: active && live,
            style: { stroke: active ? '#a6e8c8' : '#444d4a', strokeWidth: 1.3 },
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
    [edges, nodes, live],
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
      <div className="graph-canvas">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.22 }}
          minZoom={0.25}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          deleteKeyCode={null}
          colorMode="dark"
          onNodeClick={(_, node) => setSelected(node.id)}
          onPaneClick={() => setSelected(null)}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#303734" />
          <Controls showInteractive={false} />
          <ViewportManager count={nodes.length} />
          <Panel position="top-left" className="canvas-label">
            <Radio size={12} />
            {runId ? 'todo-app / architecture' : 'Awaiting first build'}
          </Panel>
          {!runId && (
            <Panel position="bottom-center" className="graph-empty">
              <span className="empty-overline">EVERY BUILD TELLS A STORY</span>
              <strong>Watch yours unfold.</strong>
              <p>
                Start a build to see files, services, and connections
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
                onClick={() => setSelected(null)}
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
            </Panel>
          )}
        </ReactFlow>
      </div>
      <footer className="graph-footer">
        <div className="graph-legend">
          {(['planned', 'active', 'completed', 'failed'] as const).map((status) => (
            <span key={status}>
              <i className={`legend-dot ${status}`} />
              {status}
            </span>
          ))}
        </div>
        <span className="graph-hint">Scroll to zoom · Drag to pan</span>
      </footer>
    </section>
  );
}

export function ArchitectureGraph(props: Props) {
  return (
    <ReactFlowProvider>
      <Graph {...props} />
    </ReactFlowProvider>
  );
}
