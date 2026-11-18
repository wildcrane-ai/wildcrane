// Read-only contract for historical saved diagrams. New Studios have no role graph.

import type { AgentIcon } from '../agents/icon.ts'
export interface DiagramStep {
  agent: string
  title: { en: string; zh: string }
  icon?: AgentIcon
  optional?: true
  after?: string[]
}

export interface StudioDiagram {
  version: 1
  rounds: DiagramStep[][]
  land: DiagramStep[]
  scheduled: (DiagramStep & { cadence?: string })[]
}
