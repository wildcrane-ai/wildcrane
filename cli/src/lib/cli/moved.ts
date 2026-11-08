// Where a word that used to be a command went. Nothing runs: it only answers the refusal.

import { FLOWS, flowPath } from '../agent/flows'

const RAW_GROUPS = ['card', 'delivery', 'run', 'triage', 'previews', 'components', 'agent', 'review-dismissals', 'describe-project', 'reflect']

/** The old word, and the line to type now. */
export const MOVED: Record<string, string> = {
  ...Object.fromEntries(FLOWS.filter((flow) => !flow.internal).map((flow) => [flow.command, `raw ${flowPath(flow)}`])),
  ...Object.fromEntries(RAW_GROUPS.map((word) => [word, `raw ${word}`])),
  create: 'raw create',
  runs: 'raw run list',
  log: 'raw run log',
  stop: 'raw run stop',
  resume: 'raw run resume',
  cancel: 'raw delivery cancel',
  discard: 'raw delivery cancel',
  board: 'raw',
  version: '--version',
}

/** The whole refusal for a word that used to be a command, or '' when it never was. */
export function movedTo(word: string, program: string): string {
  // Inside `akb raw` the words are already where they belong.
  if (/ raw$/.test(program)) return ''
  if (word === 'cloud') {
    return `\`${program} cloud\` is gone: use \`${program} account\`, \`${program} image\`, \`${program} tts\`, \`${program} music\` or \`${program} template\`.`
  }
  const now = MOVED[word]
  return now ? `\`${program} ${word}\` is now \`${program} ${now}\`.` : ''
}

/** The word a Commander refusal was about — `unknown command 'refine'`. */
export function unknownWord(message: string): string {
  return /unknown command '([^']+)'/.exec(message)?.[1] ?? ''
}
