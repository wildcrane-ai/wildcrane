import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { machineHome } from '../../machine/home'
import { spawnSync } from 'node:child_process'

import { locate, copyEnv } from '../locate'
import { spawnable } from '../spawnable'
import { home } from './models'
import { namesFlag, SKILL_SENTENCE, type Harness } from './types'
import { translating } from '../language'
import { createAntigravityRenderer } from '../wire/antigravity'

export function antigravityModels(output: string): { id: string; name: string }[] {
  return output.split('\n').flatMap((line) => {
    const match = /^([^\s]+)\t(.+)$/.exec(line.trim())
    return match ? [{ id: match[1]!, name: match[2]! }] : []
  })
}

function args(argv: string[], resume?: string): string[] {
  // Never let a saved raw argument select the latest or a different conversation.
  if (namesFlag(argv, ['--continue', '-c', '--conversation', '--remote-agent'])) throw new Error(translating() ? '请通过 WildCrane 选择 Antigravity 会话，不要在额外参数中指定会话或远程执行。' : 'Antigravity: select a session through WildCrane, not extra arguments.')
  if (resume && (!/^[a-f0-9-]{36}$/i.test(resume) || !fs.existsSync(home('.gemini', 'antigravity-cli', 'conversations', `${resume}.db`)))) throw new Error(translating() ? 'Antigravity 会话不存在。请在本机恢复原会话后续接。' : 'Antigravity session not found. Restore the original conversation on this computer before resuming.')
  const extra = resume ? ['--conversation', resume] : []
  if (!namesFlag(argv, ['--output-format'])) extra.push('--output-format', 'stream-json')
  if (!namesFlag(argv, ['--dangerously-skip-permissions'])) extra.push('--dangerously-skip-permissions')
  if (!namesFlag(argv, ['--print', '-p', '--prompt'])) extra.push('--print')
  return extra
}

/** agy 1.5.6: local credentials, explicit conversation ids and its own NDJSON protocol. */
export const ANTIGRAVITY: Harness = {
  name: 'antigravity',
  label: 'Antigravity CLI',
  icon: '/agents/antigravity.svg',
  command: 'agy --output-format stream-json --dangerously-skip-permissions',
  extraArgs: (argv) => args(argv),
  resumes: true,
  resumeArgs: (argv, id) => args(argv, id),
  settings: [{
    key: 'model', agentOwned: true, label: 'Model', kind: 'text', flags: ['--model'],
    placeholder: 'model-id',
    help: "A model from agy models. Empty uses the CLI default; an invalid model fails the run.",
  }],
  models() {
    const copy = locate(ANTIGRAVITY)
    if (!copy) return []
    const start = spawnable(copy.file, ['models'], { env: copyEnv(copy.file), stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 })
    const result = spawnSync(start.command, start.args, { ...start.options, encoding: 'utf8' })
    return result.status === 0 ? antigravityModels(result.stdout ?? '').map(m => m.id) : []
  },
  env: () => ({ ...process.env }),
  renderer: (_cwd, _binary, argv = []) => {
    const at = argv.indexOf('--conversation')
    return createAntigravityRenderer(at >= 0 ? argv[at + 1] : argv.find(a => a.startsWith('--conversation='))?.slice(15))
  },
  systemPrompt(text, _argv, env) {
    const rule = `${text}\n\nThe task working directory is ${env.PWD ?? process.cwd()}. Use it as the base for project files and commands. This additional workspace contains only language rules; do not write task output here.`
    const hash = createHash('sha256').update(rule).digest('hex').slice(0, 16)
    const root = path.join(machineHome(), 'prompts', `antigravity-${hash}`)
    const file = path.join(root, '.agents', 'rules', 'language.md')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `---\ntrigger: always_on\n---\n\n${rule}\n`)
    return { args: ['--add-dir', root] }
  },
  reports: ['tokens', 'model'],
  adoptsSessionId: false,
  savesSessionAtOpen: false,
  stopsOnRateLimit: false,
  skillCall: SKILL_SENTENCE,
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
