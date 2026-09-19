import type {
  AgentEvent,
  CommandResult,
  FileChange,
  GraphEdge,
  GraphNode,
  Stage,
  StageVisit,
  SessionInfo,
  TestResult,
} from '../types/events';

export type Connection = 'idle' | 'connecting' | 'streaming' | 'complete' | 'error';
export interface BuildState {
  mode: 'demo' | 'live';
  session: SessionInfo | null;
  connection: Connection;
  runId: string | null;
  stage: Stage | null;
  visits: StageVisit[];
  current: AgentEvent | null;
  agentReport: AgentEvent | null;
  events: AgentEvent[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  files: FileChange[];
  tests: Record<string, TestResult>;
  commands: CommandResult[];
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export const initialState = (mode: 'demo' | 'live' = 'demo'): BuildState => ({
  mode,
  session: null,
  connection: 'idle',
  runId: null,
  stage: null,
  visits: [],
  current: null,
  agentReport: null,
  events: [],
  nodes: mode === 'live' ? [] : [
    { id: 'agent', label: 'AI Agent', kind: 'agent', state: 'planned', message: 'Ready to build' },
  ],
  edges: [],
  files: [],
  tests: {},
  commands: [],
  error: null,
  startedAt: null,
  finishedAt: null,
});

export type BuildAction =
  | { type: 'reset' }
  | { type: 'transport'; connection: Connection; error?: string }
  | { type: 'session'; session: SessionInfo | null }
  | { type: 'snapshot'; session: SessionInfo | null; events: AgentEvent[]; retainedEvents?: AgentEvent[]; graph: { nodes: GraphNode[]; edges: GraphEdge[] } }
  | { type: 'start'; now: number }
  | { type: 'event'; event: AgentEvent }
  | { type: 'error'; message: string };

export function buildReducer(state: BuildState, action: BuildAction): BuildState {
  if (action.type === 'reset') return initialState(state.mode);
  if (action.type === 'transport') return { ...state, connection: action.connection, error: action.error ?? null };
  if (action.type === 'session') {
    const next = action.session?.runId !== state.session?.runId ? { ...initialState('live'), connection: state.connection } : state;
    return { ...next, session: action.session, runId: action.session?.runId ?? null, startedAt: action.session ? Date.parse(action.session.connectedAt) : null };
  }
  if (action.type === 'snapshot') {
    let next = { ...initialState('live'), connection: 'streaming' as Connection, session: action.session, runId: action.session?.runId ?? null, startedAt: action.session ? Date.parse(action.session.connectedAt) : null };
    const events = [...new Map([...(action.retainedEvents ?? []), ...action.events].map((event) => [event.eventId, event])).values()].sort((a, b) => a.sequence - b.sequence);
    for (const event of events) next = buildReducer(next, { type: 'event', event });
    return { ...next, events: action.events, nodes: action.graph.nodes, edges: action.graph.edges };
  }
  if (action.type === 'start')
    return { ...initialState(), connection: 'connecting', startedAt: action.now };
  if (action.type === 'error')
    return { ...state, connection: 'error', error: action.message, finishedAt: Date.now() };
  const event = action.event;
  // Ignore events from a canceled run, duplicates, and out-of-order deliveries.
  if (
    (state.mode === 'demo' && (state.connection === 'idle' || state.connection === 'error' || state.connection === 'complete')) ||
    (state.runId && state.runId !== event.runId) ||
    state.events.some((previous) => previous.eventId === event.eventId) ||
    event.sequence <= (state.events.at(-1)?.sequence ?? 0)
  )
    return state;
  const next: BuildState = {
    ...state,
    runId: event.runId,
    connection: 'streaming',
    current: event.type.startsWith('graph_') ? state.current : event,
    agentReport: event.source === 'agent' && (event.type === 'agent_stage' || event.type === 'agent_message') ? event : state.agentReport,
    events: [...state.events, event].slice(-500),
    session: state.session ? { ...state.session, eventCount: Math.max(state.session.eventCount, event.sequence), lastActivityAt: event.timestamp } : null,
  };
  switch (event.type) {
    case 'agent_stage':
      next.stage = event.data.stage;
      next.visits = [
        ...state.visits,
        { stage: event.data.stage, timestamp: event.timestamp, sequence: event.sequence, source: event.source, message: event.data.message },
      ].slice(state.mode === 'live' ? -50 : 0);
      break;
    case 'graph_node_added':
      next.nodes = [...state.nodes.filter((node) => node.id !== event.data.id), event.data];
      break;
    case 'graph_node_updated':
      next.nodes = state.nodes.map((node) =>
        node.id === event.data.nodeId
          ? { ...node, state: event.data.state, message: event.data.message }
          : node,
      );
      break;
    case 'graph_edge_added':
      next.edges = [...state.edges.filter((edge) => edge.id !== event.data.id), event.data];
      break;
    case 'graph_node_removed':
      next.nodes = state.nodes.filter((node) => node.id !== event.data.nodeId);
      next.edges = state.edges.filter((edge) => edge.source !== event.data.nodeId && edge.target !== event.data.nodeId);
      break;
    case 'graph_edge_removed':
      next.edges = state.edges.filter((edge) => edge.id !== event.data.edgeId);
      break;
    case 'file_created':
    case 'file_modified':
    case 'file_deleted':
      next.files = [
        {
          eventId: event.eventId,
          path: event.data.path,
          kind: event.type === 'file_created' ? 'created' : event.type === 'file_deleted' ? 'deleted' : 'modified',
          timestamp: event.timestamp,
          source: event.source,
        },
        ...state.files,
      ].slice(0, 500) as FileChange[];
      break;
    case 'test_started':
    case 'test_passed':
    case 'test_failed':
      next.tests = {
        ...state.tests,
        [event.data.name]: {
          ...event.data,
          source: event.source,
          status:
            event.type === 'test_started'
              ? 'running'
              : event.type === 'test_passed'
                ? 'passed'
                : 'failed',
        },
      };
      break;
    case 'command_started':
    case 'command_finished': {
      const command = { ...event.data, id: event.data.commandId, status: event.status, source: event.source };
      next.commands = state.commands.some((item) => item.id === command.id)
        ? state.commands.map((item) => (item.id === command.id ? command : item))
        : [...state.commands, command];
      break;
    }
    case 'build_complete':
      if (state.mode === 'demo') {
        next.connection = 'complete';
        next.finishedAt = Date.parse(event.timestamp);
      }
      break;
  }
  return next;
}
