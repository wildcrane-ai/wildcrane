import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ASSETS, BOARD_STATE, TODO } from '../paths'
import { agentMemoryDir } from '../memory'
import { withLock } from '../lock'
import { findSpecAgent, specAgentAssigned, specHeadingRe } from '../agents'
import { canonicalSpecAgent } from '../spec-agent-names'
import { findCard } from '../view/read'
import { cardStudioId } from './studios'
import { studioFiles } from './studio-shared'
import { readRuns } from './store'
import { insideRun, SESSION_VARS, STOP_ENV } from './env'
import { locate } from '../cards'
import { parseFrontmatter } from '../frontmatter'
import { executionOf } from '../cloud/execution'
import { call, numberOf, workspaceTask, type CloudTask } from '../cloud/tasks'
import { PREVIEW_BRIDGE_ENV } from '../cloud/preview'
import { validatePreviewFiles } from '../preview-files'
import { beginPreviewRevision, previewBaseline, previewReady, selectPreviewStages, submitPreviewStage, type PreviewBaseline, type PreviewProgress } from '../preview-stages'

const file = (id: number) => path.join(BOARD_STATE, 'previews', `${id}.json`)
export function readPreviewProgress(id: number): Record<string, PreviewProgress> {
  try { return JSON.parse(fs.readFileSync(file(id), 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}
export function updatePreviewProgress<T>(id: number, change: (all: Record<string, PreviewProgress>) => T): T {
  fs.mkdirSync(path.dirname(file(id)), { recursive: true })
  return withLock(`${file(id)}.lock`, 'updating preview progress', () => {
    const all = readPreviewProgress(id)
    const result = change(all)
    const temp = `${file(id)}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(all) + '\n')
    fs.renameSync(temp, file(id))
    return result
  })
}
export function freezePreviewProgress(id: number, name: string): PreviewProgress | null {
  const held = readPreviewProgress(id)[name]
  if (held) return held
  const agent = findSpecAgent(name)
  if (!agent) return null
  const studio = studioFiles(cardStudioId(id)) ?? {}
  const protocol = Object.entries(studio).some(([path, text]) => path.endsWith('/AGENT.md') && /^[ \t]+stages:/m.test(text.split(/\r?\n---/)[0]!))
  if (!agent.stages && !protocol) return null
  const definitions = agent.stages ?? [{ id: 'preview', title: { en: 'Preview', zh: '成果' }, instructions: 'preview.md' }]
  const files = Object.fromEntries(agent.files.map((file) => [file, agent.file(file)]).filter((entry): entry is [string, string] => entry[1] !== null))
  if (!agent.stages) files['preview.md'] = agent.body
  for (const stage of definitions) files[stage.instructions] ??= agent.file(stage.instructions)!
  const definitionRevision = createHash('sha256').update(JSON.stringify({ stages: definitions, body: agent.body, files })).digest('hex')
  const progress: PreviewProgress = { agent: name, definitionRevision, generation: 1, currentStageId: null, definitions, body: agent.body, files, stages: [], displayedArtifact: null, execution: null }
  if (!agent.stages) selectPreviewStages(progress, ['preview'])
  return updatePreviewProgress(id, (all) => all[name] ??= progress)
}
export function previewStagePrompt(id: number, name: string, command: string): string {
  const progress = freezePreviewProgress(id, name)
  if (!progress) return ''
  if (progress.revisionBase) return `A revision is requested. Inspect the saved work and feedback. Choose the earliest affected stage with: ${command} raw previews ${name} ${id} --revise-from <stage-id>. Preserve confirmed earlier stages; do not produce work before choosing. Saved stages: ${JSON.stringify(progress.revisionBase.map(({ id, title, status, artifact }) => ({ id, title, status, artifact })))}`
  if (!progress.stages.length) return `Stage definitions (frozen):\n${JSON.stringify(progress.definitions)}\nChoose the work this task needs, then run: ${command} raw previews ${name} ${id} --stages <id,...>. Do not produce work before saving the selection.`
  const current = progress.stages.find((stage) => stage.id === progress.currentStageId)!
  if (current.status === 'awaiting_confirmation' || previewReady(progress)) return 'The submitted preview is awaiting review. Do not revise or advance it without user feedback.'
  return [
    `Selected stages: ${progress.stages.map((stage) => stage.id).join(', ')}. Current stage: ${current.id}.`,
    progress.files[current.instructions],
    ...(name === 'ui-designer' ? [current.id === 'copywriting' ? legacyPreviewMemory('copywriting') : current.id === 'illustration' ? legacyPreviewMemory('illustrator') : ''] : []),
    ...progress.stages.filter((stage) => stage.status === 'confirmed').map((stage) => `Confirmed ${stage.id} v${stage.version}:\n${stage.artifact?.body ?? ''}`),
    `Write only the current work in your existing section. Submit it with: ${command} raw previews ${name} ${id} --submit --stage ${current.id}. Stop after success.`,
  ].join('\n\n')
}
export async function assertPreviewTask(id: number): Promise<void> {
  if (!process.env[PREVIEW_BRIDGE_ENV]) return
  const task = workspaceTask()
  if (!task) throw Error('The preview bridge needs its current task.')
  const source = await call<CloudTask>('GET', `/v1/tasks/${encodeURIComponent(task)}`)
  if (!source.ok) throw Error(source.error)
  if (numberOf(source.value.key) !== id) throw Error('Only the current task can prepare previews from this session.')
}
function previewOwner(id: number, name: string, inside = insideRun()): string {
  const found = locate(id)
  if (!found) throw Error('The task is no longer open.')
  const card = found.kind === 'group' ? path.join(found.target, 'root.md') : found.target
  const { meta } = parseFrontmatter(fs.readFileSync(card, 'utf8'))
  if (!specAgentAssigned(name, meta?.studio) || !meta?.previews?.some((agent) => canonicalSpecAgent(agent) === name)) throw Error('Choose this preview agent on the task first.')
  if (inside) {
    const run = readRuns().find((run) => run.sessionId === inside)
    if (!run || run.status !== 'running' || run.cardId !== id || (run.action === 'spec' ? run.specAgent !== name : !['clarify', 'edit', 'resolve', 'approve'].includes(run.action))) throw Error('Only the active task session can prepare its selected previews.')
    return `run:${inside}`
  }
  const execution = executionOf()
  if (execution) return `job:${execution.job}`
  return process.env[STOP_ENV] || Object.values(SESSION_VARS).map((key) => process.env[key]).find(Boolean) || 'external'
}
const contextFile = (id: number, name: string, owner: string) => path.join(BOARD_STATE, 'previews', 'contexts', String(id), name, `${createHash('sha256').update(owner).digest('hex')}.json`)
interface PreviewContext { sessionId: string; request: string; active?: boolean }
function readContext(file: string): PreviewContext | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value) + '\n')
  fs.renameSync(temp, file)
}
export function previewRun(id: number, name: string): PreviewContext {
  const context = readContext(contextFile(id, name, previewOwner(id, name)))
  if (!context?.active) throw Error('Enter this preview with --print before selecting or submitting its stages.')
  const progress = readPreviewProgress(id)[name]
  if (progress?.execution && progress.execution !== context.sessionId && !progress.execution.endsWith(`:${context.sessionId}`)) throw Error('This execution is outdated. Reload the task.')
  return context
}
export function selectLocalPreview(id: number, name: string, ids: string[]) {
  const run = previewRun(id, name)
  return updatePreviewProgress(id, (all) => {
    const progress = all[name]
    if (!progress) throw Error('This agent has no staged preview.')
    if (progress.execution !== run.sessionId) throw Error('This execution is outdated. Reload the task.')
    if (progress.stages.length && JSON.stringify(progress.stages.map((stage) => stage.id)) === JSON.stringify(ids)) return { progress, baseline: readPreviewBaseline(id, name, run.sessionId) }
    selectPreviewStages(progress, ids)
    const baseline = previewBaseline(progress, progress.currentStageId!, run.sessionId)
    return { progress, baseline }
  })
}
export function previewSection(body: string, name: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex((line) => specHeadingRe(name).test(line))
  if (start < 0) throw Error('Write the preview in its own section before submitting it.')
  const end = lines.findIndex((line, index) => index > start && (/^## /.test(line) || line.trim() === '<!-- agent -->'))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
}
export function submitLocalPreview(id: number, name: string, stage: string, baseline?: PreviewBaseline) {
  const run = previewRun(id, name)
  const card = findCard(id)
  if (!card) throw Error('The task is no longer open.')
  const body = previewSection(card.body, name)
  const problems = validatePreviewFiles(path.join(TODO, card.relPath), id, body)
  if (problems.length) throw Error(problems.map((problem) => problem.message).join('\n'))
  // Freeze the complete asset folder so relative dependencies survive subsequent edits.
  const snapshot = randomUUID()
  const source = path.join(ASSETS, String(id))
  const dest = path.join(BOARD_STATE, 'previews', 'assets', String(id), snapshot)
  if (fs.existsSync(source)) fs.cpSync(source, dest, { recursive: true, dereference: true })
  return updatePreviewProgress(id, (all) => {
    const progress = all[name]
    if (!progress) throw Error('Select the stages first.')
    const base = baseline ?? readPreviewBaseline(id, name, run.sessionId)
    if (base.stageId !== stage) throw Error('Wrong stage.')
    return submitPreviewStage(progress, base, body, { folder: dest })
  })
}

const baselineFile = (id: number, name: string, run: string) => path.join(BOARD_STATE, 'previews', 'runs', String(id), name, `${run}.json`)
export function savePreviewBaseline(id: number, name: string, run: string, baseline: PreviewBaseline): void {
  writeJson(baselineFile(id, name, run), baseline)
}
export function readPreviewBaseline(id: number, name: string, run: string): PreviewBaseline {
  return JSON.parse(fs.readFileSync(baselineFile(id, name, run), 'utf8'))
}
export async function activatePreviewRun(id: number, name: string, run?: string, request = ''): Promise<void> {
  await assertPreviewTask(id)
  const owner = previewOwner(id, name, run ?? insideRun())
  const file = contextFile(id, name, owner)
  const held = readContext(file)
  const context = held && held.request === request ? held : { sessionId: run ?? randomUUID(), request }
  if (held?.active && held.sessionId === context.sessionId) {
    const progress = readPreviewProgress(id)[name]
    if (progress?.execution && progress.execution !== context.sessionId && !progress.execution.endsWith(`:${context.sessionId}`)) throw Error('This execution is outdated. Reload the task.')
  }
  // Persist before contacting the bridge so an interrupted entry retries the same execution.
  writeJson(file, context)
  run = context.sessionId
  const { previewBridge } = await import('../cloud/preview')
  const remote = await previewBridge(name, 'start', { run })
  if (remote) {
    if (remote.progress) updatePreviewProgress(id, (all) => { all[name] = remote.progress! })
    if (remote.baseline) savePreviewBaseline(id, name, run, remote.baseline)
  } else {
    freezePreviewProgress(id, name)
    updatePreviewProgress(id, (all) => {
      const progress = all[name]
      if (!progress) return
      const current = progress.stages.find((stage) => stage.id === progress.currentStageId)
      if (held?.active && held.sessionId === run && progress.execution && progress.execution !== run) throw Error('This execution is outdated. Reload the task.')
      if (current && ['awaiting_confirmation', 'ready'].includes(current.status)) {
        if (progress.execution === run) return
        beginPreviewRevision(progress, run!)
      }
      if (progress.currentStageId && !progress.revisionBase) savePreviewBaseline(id, name, run!, previewBaseline(progress, progress.currentStageId, run!))
      else progress.execution = run!
    })
  }
  writeJson(file, { ...context, active: true })
}

export function frozenPreviewFile(agent: string, relative: string): string | undefined {
  const run = readRuns().find((run) => run.sessionId === insideRun())
  if (run?.action !== 'spec' || run.specAgent !== agent || run.cardId === null) return undefined
  return readPreviewProgress(run.cardId)[agent]?.files[relative]
}

function legacyPreviewMemory(agent: string): string {
  const folder = agentMemoryDir(agent)
  try { return fs.readdirSync(folder).filter((name) => name.endsWith('.md')).map((name) => `Existing ${agent} preferences (${name}):\n${fs.readFileSync(path.join(folder, name), 'utf8')}`).join('\n\n') } catch { return '' }
}
