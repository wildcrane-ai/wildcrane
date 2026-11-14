import fs from 'node:fs'
import path from 'node:path'

import { RULES } from '../paths'
import { DELIVERY_FLOWS, FLOWS, flowByAction, flowByCommand, type Flow } from './flows'
import { hiddenRole, roleForFlow, roleNamed, type AgentRole } from './roles'
import { agentForRun, studioForRun } from './runner'
import { landAgents, studioFor } from './studios'
import { REFINE_ACTIONS, SPECIALIST_ACTIONS } from './types'
import type { AgentRequest } from './types'

const rulePath = (agent: string): string => path.join(RULES, `${agent}.md`)

// Read one agent's current rule.
function ruleFile(agent: string): string {
  if (!agent || hiddenRole(agent)) return ''
  try {
    return fs.readFileSync(rulePath(agent), 'utf8').trim()
  } catch {
    return ''
  }
}

/** One agent's rule as it stands on disk — empty when there is no file, it can't be read,
 *  or it holds nothing but whitespace. `agent` is a role or a specialist's name. */
export function readRule(agent: string): string {
  return ruleFile(agent)
}

/** The rules a delivery freezes when it starts, keyed by the AGENT that carries each: the
 *  agents a delivery's flows are run by, read once, the way it reads the card it was
 *  approved to build. Editing a rule afterwards changes the next delivery, never one in
 *  flight. */
export function deliveryRules(studio?: string): Record<string, string> {
  const rules: Record<string, string> = {}
  for (const flow of FLOWS) {
    if (flow.action === 'refine' || !DELIVERY_FLOWS.has(flow.action)) continue
    const role = roleForFlow(flow.command, studio)
    if (!role || rules[role.name] !== undefined) continue
    const rule = ruleFile(role.name)
    if (rule) rules[role.name] = rule
  }
  const flow = studioFor(studio)
  for (const { agent } of flow ? landAgents(flow) : []) {
    const rule = ruleFile(agent)
    if (rule) rules[agent] = rule
  }
  return rules
}

// Which flow a run belongs to. A refinement pass is part of the composite `refine` flow, so
// every pass in it reads the same rule.
const flowForRequest = (req: AgentRequest): Flow | undefined =>
  req.refineRound !== undefined && REFINE_ACTIONS.has(req.action)
    ? flowByCommand('refine')
    : flowByAction(req.action)

interface RuleOwner {
  name: string
  role?: AgentRole
}

function ownerOf(req: AgentRequest): RuleOwner | null {
  if (req.action === 'implement') {
    const name = agentForRun(req)
    return name ? { name, role: roleNamed(name) } : null
  }
  if (SPECIALIST_ACTIONS.has(req.action) || req.action === 'sub') {
    const name = req.specAgent ?? ''
    return name ? { name } : null
  }
  // A reflection is the proposer's (#534) and is no flow a person types under `akb raw card`,
  // so it names itself here.
  const flow = req.action === 'reflect' ? req.action : flowForRequest(req)?.command
  const role = roleForFlow(flow ?? '', studioForRun(req))
  return role ? { name: role.name, role } : null
}

export function ruleFor(req: AgentRequest, frozen?: Record<string, string>): string {
  const owner = ownerOf(req)
  if (!owner) return ''
  if (frozen && DELIVERY_FLOWS.has(req.action)) return frozen[owner.name] ?? ''
  if (frozen && SPECIALIST_ACTIONS.has(req.action)) {
    return frozen[owner.name] ?? ''
  }
  return readRule(owner.name)
}

/** Whose rule a run reads, as a caption says it out loud: the agent's name, and whether the
 *  rule carries across every flow that agent runs — it does for a role, and a specialist has
 *  no flows. The ask and a printed flow both name it, so they name it the same way. */
export function ruleOwner(req: AgentRequest): { name: string; role: boolean } | null {
  const owner = ownerOf(req)
  return owner ? { name: owner.name, role: Boolean(owner.role) } : null
}

/** How a caption names the agent whose rule follows — the clause both say, without the
 *  "this board's" each one leads with in its own case. */
export const ruleOwnerSays = (owner: { name: string; role: boolean }): string =>
  `\`${owner.name}\` agent carries one rule of its own${owner.role ? ', on every flow it runs' : ''}`

/** The rule as a run is given it: the user's words, and one line of the board's before them
 *  saying whose they are. Empty when the agent has no rule. */
export function ruleBlock(req: AgentRequest, frozen?: Record<string, string>): string {
  return said(ruleOwner(req), ruleFor(req, frozen))
}

const said = (owner: { name: string; role: boolean } | null, rule: string): string =>
  owner && rule
    ? [
        `This board's ${ruleOwnerSays(owner)}. It is the user's, it applies here, and nothing of the board's follows it:`,
        rule,
      ].join('\n\n')
    : ''
