import type {
  AgentEvent,
  CommandResult,
  FileChange,
  GraphEdge,
  GraphNode,
  Stage,
  StageVisit,
  TestResult,
} from '../types/events';

export type Connection = 'idle' | 'connecting' | 'streaming' | 'complete' | 'error';
export interface BuildState {
  connection: Connection;
  runId: string | null;
  stage: Stage | null;
  visits: StageVisit[];
  current: AgentEvent | null;
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

export const initialState = (): BuildState => ({
  connection: 'idle',
  runId: null,
  stage: null,
  visits: [],
  current: null,
  events: [],
  nodes: [
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
  | { type: 'start'; now: number }
  | { type: 'event'; event: AgentEvent }
  | { type: 'error'; message: string };

export function buildReducer(state: BuildState, action: BuildAction): BuildState {
  if (action.type === 'reset') return initialState();
  if (action.type === 'start')
    return { ...initialState(), connection: 'connecting', startedAt: action.now };
  if (action.type === 'error')
    return { ...state, connection: 'error', error: action.message, finishedAt: Date.now() };
  const event = action.event;
  // Ignore events from a canceled run, duplicates, and out-of-order deliveries.
  if (
    state.connection === 'idle' ||
    state.connection === 'error' ||
    state.connection === 'complete' ||
    (state.runId && state.runId !== event.runId) ||
    state.events.some((previous) => previous.eventId === event.eventId) ||
    event.sequence <= (state.events.at(-1)?.sequence ?? 0)
  )
    return state;
  const next: BuildState = {
    ...state,
    runId: event.runId,
    connection: 'streaming',
    current: event,
    events: [...state.events, event],
  };
  switch (event.type) {
    case 'agent_stage':
      next.stage = event.data.stage;
      next.visits = [
        ...state.visits,
        { stage: event.data.stage, timestamp: event.timestamp, sequence: event.sequence },
      ];
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
    case 'file_created':
    case 'file_modified':
      next.files = [
        {
          eventId: event.eventId,
          path: event.data.path,
          kind: event.type === 'file_created' ? 'created' : 'modified',
          timestamp: event.timestamp,
        },
        ...state.files,
      ];
      break;
    case 'test_started':
    case 'test_passed':
    case 'test_failed':
      next.tests = {
        ...state.tests,
        [event.data.name]: {
          ...event.data,
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
      const command = { ...event.data, id: event.data.commandId, status: event.status };
      next.commands = state.commands.some((item) => item.id === command.id)
        ? state.commands.map((item) => (item.id === command.id ? command : item))
        : [...state.commands, command];
      break;
    }
    case 'build_complete':
      next.connection = 'complete';
      next.finishedAt = Date.parse(event.timestamp);
      break;
  }
  return next;
}
