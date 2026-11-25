import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { machineHome } from '../../machine/home'
import { spawnSync } from 'node:child_process'

import { locate, copyEnv } from '../locate'
import { spawnable } from '../spawnable'
import { home } from './models'
import { namesFlag, type Harness } from './types'
import { translating } from '../language'
import { createAcpClient } from '../wire/acp'
import { createAntigravityRenderer } from '../wire/antigravity'
import { ExecutionError } from '../wire/failures'
import { makeFailure } from '../retry'
import { antigravityConversationFile } from '../wire/antigravity-session'

const EFFORT_ID = /-(?:low|medium|high|xhigh|max)$/i
const EFFORT_NAME = /\s*\((?:low|medium|high|xhigh|max)\)$/i

export function antigravityModels(output: string): { id: string; name: string }[] {
  const seen = new Set<string>()
  const models: { id: string; name: string }[] = []
  for (const line of output.split('\n')) {
    const match = /^([^\s]+)\t(.+)$/.exec(line.trim())
    if (!match) continue
    const id = match[1]!.replace(EFFORT_ID, '')
    const name = match[2]!.replace(EFFORT_NAME, '').trim()
    if (seen.has(id)) continue
    seen.add(id)
    models.push({ id, name })
  }
  return models
}

function args(argv: string[], resume?: string): string[] {
  // Never let a saved raw argument select the latest or a different conversation.
  if (namesFlag(argv, ['--continue', '-c', '--conversation', '--remote-agent'])) throw new Error(translating() ? '请通过 WildCrane 选择 Antigravity 会话，不要在额外参数中指定会话或远程执行。' : 'Antigravity: select a session through WildCrane, not extra arguments.')
  if (resume) {
    const file = antigravityConversationFile(resume)
    if (!file || !fs.existsSync(file)) throw new ExecutionError(makeFailure('runtime', translating()
      ? 'Antigravity 会话不存在。请在本机恢复原会话后续接。'
      : 'Antigravity session not found. Restore the original conversation on this computer before resuming.', { code: 'session_not_found' }))
  }
  const extra = resume ? ['--conversation', resume] : []
  if (!namesFlag(argv, ['--output-format'])) extra.push('--output-format', 'stream-json')
  if (!namesFlag(argv, ['--dangerously-skip-permissions'])) extra.push('--dangerously-skip-permissions')
  if (!namesFlag(argv, ['--print', '-p', '--prompt'])) extra.push('--print')
  return extra
}

function systemPrompt(text: string, _argv: string[], env: NodeJS.ProcessEnv) {
  const rule = `${text}\n\nThe task working directory is ${env.PWD ?? process.cwd()}. Use it as the base for project files and commands. This additional workspace contains only language rules; do not write task output here.`
  const hash = createHash('sha256').update(rule).digest('hex').slice(0, 16)
  const root = path.join(machineHome(), 'prompts', `antigravity-${hash}`)
  const file = path.join(root, '.agents', 'rules', 'language.md')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `---\ntrigger: always_on\n---\n\n${rule}\n`)
  return { args: ['--add-dir', root] }
}

/** agy 1.5.6: local credentials, explicit conversation ids and its own NDJSON protocol. */
export const ANTIGRAVITY: Harness = {
  name: 'antigravity',
  label: 'Antigravity CLI',
  icon: '/agents/antigravity.svg',
  command: 'agy --output-format stream-json --dangerously-skip-permissions',
  discussionImages: {
    args: ['acp', '--dangerously-skip-permissions'],
    client: ({ model, reasoning }) => createAcpClient({
      tool: 'antigravity', model, config: { thought_level: reasoning }, fallbackOnSetupFailure: true,
    }),
    systemPrompt,
    fallbackToPath: true,
  },
  extraArgs: (argv) => args(argv),
  resumes: true,
  resumeArgs: (argv, id) => args(argv, id),
  settings: [{
    key: 'model', agentOwned: true, label: 'Model', kind: 'text', flags: ['--model'],
    placeholder: 'model-id',
    help: "A model from agy models. Empty uses the CLI default; an invalid model fails the run.",
  }, {
    key: 'reasoning',
    agentOwned: true,
    label: 'Reasoning effort',
    kind: 'select',
    choices: [
      { value: '', label: "Agent's default" },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'xhigh', label: 'Extra high (xhigh)' },
      { value: 'max', label: 'Max' },
    ],
    flags: ['--effort'],
    help: 'Lower is quicker and cheaper, higher is slower and more careful.',
    overriddenHelp: `Not in effect: this agent's "command" in your ui.config.json already names an effort level, and that wins.`,
  }],
  models() {
    const copy = locate(ANTIGRAVITY)
    if (!copy) return []
    const start = spawnable(copy.file, ['models'], { env: copyEnv(copy.file), stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 })
    const result = spawnSync(start.command, start.args, { ...start.options, encoding: 'utf8' })
    return result.status === 0 ? antigravityModels(result.stdout ?? '').map(m => m.id) : []
  },
  env: () => ({ ...process.env }),
  images: { as: 'message' },
  renderer: (cwd, _binary, argv = []) => {
    const at = argv.indexOf('--conversation')
    return createAntigravityRenderer(at >= 0 ? argv[at + 1] : argv.find(a => a.startsWith('--conversation='))?.slice(15), cwd)
  },
  systemPrompt,
  reports: ['cost', 'tokens', 'model', 'context'],
  adoptsSessionId: false,
  savesSessionAtOpen: true,
  stopsOnRateLimit: false,
  // `models` is read-only. Only explicit authentication errors mean signed out.
  login: {
    args: ['models'],
    timeoutMs: 1_000,
    ready: (out) => antigravityModels(out).length > 0,
    loggedOut: (out) => /authentication required|not (?:logged|signed) in|please (?:log|sign) in/i.test(out),
    login: 'agy',
  },
  installs: () => [home('.local', 'bin', 'agy'), home('AppData', 'Local', 'Programs', 'Antigravity', 'bin', 'agy.exe')],
  install: 'https://antigravity.google/docs/cli/getting-started/',
}
