import { z } from 'zod';

export const STAGES = [
  'PLANNING',
  'EXPLORING',
  'IMPLEMENTING',
  'RUNNING',
  'TESTING',
  'DEBUGGING',
  'VALIDATING',
  'COMPLETE',
] as const;
export const nodeStateSchema = z.enum(['planned', 'active', 'completed', 'failed']);
export const nodeKindSchema = z.enum([
  'agent',
  'frontend',
  'api',
  'service',
  'repository',
  'database',
  'test',
  'module',
  'config',
  'style',
]);
export type Stage = (typeof STAGES)[number];
export type NodeState = z.infer<typeof nodeStateSchema>;
export type NodeKind = z.infer<typeof nodeKindSchema>;
export type EventStatus = 'pending' | 'running' | 'completed' | 'failed';

const message = { message: z.string() };
export const nodeSchema = z.object({
  ...message,
  id: z.string(),
  label: z.string(),
  kind: nodeKindSchema,
  state: nodeStateSchema,
  path: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});
export const edgeSchema = z.object({
  ...message,
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string(),
  evidence: z.enum(['import', 'reported', 'simulated']).optional(),
});
const fileSchema = z.object({ ...message, path: z.string(), nodeId: z.string() });
const commandSchema = z.object({
  ...message,
  commandId: z.string(),
  command: z.string(),
  output: z.string().nullable().optional(),
  exitCode: z.number().int().nullable().optional(),
});
const testSchema = z.object({
  ...message,
  name: z.string(),
  nodeId: z.string(),
  attempt: z.number().int().min(1),
  details: z.string().nullable().optional(),
});
const envelope = {
  schemaVersion: z.literal(1),
  runId: z.string(),
  eventId: z.string(),
  timestamp: z.iso.datetime({ offset: true }),
  sequence: z.number().int().min(1),
  status: z.enum(['pending', 'running', 'completed', 'failed']),
  source: z.enum(['simulator', 'filesystem', 'agent', 'system', 'command']).optional(),
  agentName: z.string().nullable().optional(),
};

// The discriminator keeps consumers typed and validates data at the socket boundary.
export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelope,
    type: z.literal('agent_stage'),
    data: z.object({ ...message, stage: z.enum(STAGES) }),
  }),
  z.object({ ...envelope, type: z.literal('agent_message'), data: z.object(message) }),
  z.object({ ...envelope, type: z.literal('file_created'), data: fileSchema }),
  z.object({ ...envelope, type: z.literal('file_modified'), data: fileSchema }),
  z.object({ ...envelope, type: z.literal('file_deleted'), data: fileSchema }),
  z.object({ ...envelope, type: z.literal('command_started'), data: commandSchema }),
  z.object({ ...envelope, type: z.literal('command_finished'), data: commandSchema }),
  z.object({ ...envelope, type: z.literal('test_started'), data: testSchema }),
  z.object({ ...envelope, type: z.literal('test_passed'), data: testSchema }),
  z.object({ ...envelope, type: z.literal('test_failed'), data: testSchema }),
  z.object({ ...envelope, type: z.literal('graph_node_added'), data: nodeSchema }),
  z.object({
    ...envelope,
    type: z.literal('graph_node_updated'),
    data: z.object({ ...message, nodeId: z.string(), state: nodeStateSchema }),
  }),
  z.object({ ...envelope, type: z.literal('graph_edge_added'), data: edgeSchema }),
  z.object({ ...envelope, type: z.literal('graph_node_removed'), data: z.object({ ...message, nodeId: z.string() }) }),
  z.object({ ...envelope, type: z.literal('graph_edge_removed'), data: z.object({ ...message, edgeId: z.string() }) }),
  z.object({
    ...envelope,
    type: z.literal('build_complete'),
    data: z.object({
      ...message,
      filesTouched: z.number().int().min(0),
      testsPassed: z.number().int().min(0),
      testsTotal: z.number().int().min(0),
    }),
  }),
]);

export type AgentEvent = z.infer<typeof agentEventSchema>;
export type GraphNode = z.infer<typeof nodeSchema>;
export type GraphEdge = z.infer<typeof edgeSchema>;
export interface FileChange {
  eventId: string;
  path: string;
  kind: 'created' | 'modified' | 'deleted';
  timestamp: string;
  source?: AgentEvent['source'];
}
export interface TestResult {
  name: string;
  status: 'running' | 'passed' | 'failed';
  attempt: number;
  details?: string | null;
  source?: AgentEvent['source'];
}
export interface CommandResult {
  id: string;
  command: string;
  status: EventStatus;
  output?: string | null;
  exitCode?: number | null;
  source?: AgentEvent['source'];
}
export interface StageVisit {
  stage: Stage;
  timestamp: string;
  sequence: number;
  source?: AgentEvent['source'];
  message?: string;
  status?: EventStatus;
  eventId?: string;
  agentName?: string | null;
}

export const sessionSchema = z.object({
  runId: z.string(), projectPath: z.string(), projectName: z.string(),
  agentName: z.string().nullable(), watching: z.boolean(), connectedAt: z.string(),
  lastActivityAt: z.string(), eventCount: z.number(), trackedFiles: z.number(),
  warnings: z.array(z.string()),
  filesTouched: z.number().optional(),
});
export type SessionInfo = z.infer<typeof sessionSchema>;
export const liveFrameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), session: sessionSchema.nullable(), events: z.array(agentEventSchema), activityEvents: z.array(agentEventSchema).optional(), retainedEvents: z.array(agentEventSchema).optional(), graph: z.object({ nodes: z.array(nodeSchema), edges: z.array(edgeSchema) }) }),
  z.object({ kind: z.literal('event'), event: agentEventSchema }),
  z.object({ kind: z.literal('session'), session: sessionSchema.nullable() }),
  z.object({ kind: z.literal('heartbeat') }),
]);
export function sourceLabel(source: AgentEvent['source'], demo = false) {
  if (demo || source === 'simulator') return 'Simulated';
  if (source === 'agent') return 'Agent-reported';
  if (source === 'filesystem') return 'Observed file change';
  if (source === 'command') return 'Command wrapper';
  return 'System';
}
