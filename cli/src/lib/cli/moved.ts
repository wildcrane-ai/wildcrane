// Where a word that used to be a command went. Nothing runs: it only answers the refusal.

/** The old word, and the line to type now. */
export const MOVED: Record<string, string> = {
  card: 'task --help',
  create: 'task create',
  refine: 'task refine',
  revise: 'task revise',
  resolve: 'task resolve',
  implement: 'task implement',
  approve: 'task approve',
  previews: 'studio previews',
  'review-memory': 'memory review',
  'describe-project': 'memory describe-project',
  runs: 'run list',
  log: 'run log',
  stop: 'run stop',
  resume: 'run resume',
  cancel: 'delivery cancel',
  discard: 'delivery cancel',
  version: '--version',
}

/** The whole refusal for a word that used to be a command, or '' when it never was. */
export function movedTo(word: string, program: string): string {
  // Inside `akb raw` the words are already where they belong.
  if (/ raw$/.test(program)) {
    return word === 'archive' ? `Use \`${program.slice(0, -4)} task archive <task>\` to archive a task.` : ''
  }
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
