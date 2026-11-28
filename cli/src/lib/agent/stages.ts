const STAGES = ['discuss', 'plan', 'build'] as const

export type Stage = (typeof STAGES)[number]

/** What one stage is answerable for. */
export interface StageContract {
  stage: Stage
  /** The flows that run it, by flow name (./flows.ts). */
  flows: string[]
  /** What the stage is handed. */
  input: string
  /** What it leaves behind. */
  output: string
  /** When it is over. */
  done: string
  /** The agent that runs it and writes the one conclusion; empty when nobody does. */
  lead: string
}

/** What a flow that is no stage's is: work something on the board starts rather than a
 *  stage. */
export type NodeKind = 'event'

/** One shared node: a flow, what kind it is, and the agent that runs it. A sort has none:
 *  the command asks Cloud itself (#1263). */
export interface FlowNode {
  flow: string
  kind: NodeKind
  agent?: string
}

// Planning is the flows that write a card, settle it and close it out.
const BOARD_STAGES: StageContract[] = [
  {
    stage: 'discuss',
    flows: ['chat'],
    input: "an idea in the user's own words, and what the board already knows",
    output: 'a direction worth a card, or the finding that there is nothing to build',
    done: 'the user has what they came for — a card was written, or the idea was let go',
    lead: 'discussion-helper',
  },
  {
    stage: 'plan',
    flows: ['refine', 'resolve', 'approve', 'revise', 'archive', 'reject'],
    input: 'the card as it stands, the product description, and the saved task discussion',
    output: 'a card someone can build from without asking anything else',
    done: "nothing is left open on it but the calls that are the user's to make",
    lead: 'planner',
  },
  {
    stage: 'build',
    // `run` is retired (#1414); it stays so an old run still reads as the build's.
    flows: ['implement', 'run'],
    input: 'the approved card and the rules its delivery froze',
    output: "the approved outcome and its recorded results",
    done: 'the task has recorded completion and the card is archived',
    lead: '',
  },
]

// The nodes that are no stage's work, started by something happening rather than by a
// stage reaching them: a card finishing, a cadence coming
// round, a day passing over conversations that said something new.
const BOARD_NODES: FlowNode[] = [
  { flow: 'triage-sort', kind: 'event', agent: 'discussion-helper' },
  { flow: 'reflect', kind: 'event', agent: 'proposer' },
  { flow: 'prune-memory', kind: 'event', agent: 'memory-pruner' },
  { flow: 'review-memory', kind: 'event', agent: 'chat-reviewer' },
  { flow: 'review-dismissals', kind: 'event', agent: 'dismissal-reviewer' },
  { flow: 'describe-project', kind: 'event', agent: 'project-writer' },
]

/** This board's shared nodes — everything it can start that is no stage's. */
export const stageContracts = (): StageContract[] => BOARD_STAGES

export const flowNodes = (): FlowNode[] => BOARD_NODES

/** The stage a flow belongs to, or undefined when it is a shared node or this board has no
 *  such flow at all. */
export const stageOfFlow = (flow: string): Stage | undefined =>
  flow ? BOARD_STAGES.find((c) => c.flows.includes(flow))?.stage : undefined

/** The shared node a flow is, or undefined when it belongs to a stage or to this board not
 *  at all. */
export const nodeOfFlow = (flow: string): FlowNode | undefined =>
  flow ? flowNodes().find((n) => n.flow === flow) : undefined

/** The agent that runs one flow — the one mapping from a flow to who does it. A stage's
 *  flow resolves to its lead; a shared node's to the agent on the node. */
export const agentForFlow = (flow: string): string | undefined => {
  if (!flow) return undefined
  const stage = BOARD_STAGES.find((c) => c.flows.includes(flow))
  return stage ? stage.lead || undefined : nodeOfFlow(flow)?.agent
}

/** The flows one agent runs here, stages first and then its nodes. */
export const flowsOfAgent = (name: string): string[] => [
  ...BOARD_STAGES.filter((stage) => stage.lead === name).flatMap((stage) => stage.flows),
  ...flowNodes().filter((node) => node.agent === name).map((node) => node.flow),
]

/** Every reason a contract names somebody this board does not have. `roster` is the names
 *  the board answers to (./roles.ts). Empty when every name on every contract resolves. */
export function contractProblems(roster: readonly string[]): string[] {
  const problems: string[] = []
  const has = (name: string): boolean => roster.includes(name)
  for (const contract of BOARD_STAGES) {
    if (contract.lead && !has(contract.lead)) {
      problems.push(
        `the ${contract.stage} stage is led by \`${contract.lead}\`, and no agent on this board answers to that name.`,
      )
    }
  }
  for (const node of flowNodes()) {
    if (node.agent && !has(node.agent)) {
      problems.push(`the \`${node.flow}\` ${node.kind} is run by \`${node.agent}\`, and this board has no such agent.`)
    }
  }
  return problems
}
