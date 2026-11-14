import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { ASSETS, BOARD_STATE, TODO } from '../paths'
import { agentMemoryDir } from '../memory'
import { withLock } from '../lock'
import { findSpecAgent, specHeadingRe } from '../agents'
import { findCard } from '../view/read'
import { cardStudioId } from './studios'
import { studioFiles } from './studio-shared'
import { readRuns } from './store'
import { insideRun } from './env'
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
export function previewRun(id: number, name: string) {
  const run = readRuns().find((run) => run.sessionId === insideRun())
  if (!run || run.status !== 'running' || run.action !== 'spec' || run.specAgent !== name || run.cardId !== id) throw Error('Only the active preview agent can select or submit its stages.')
  return run
}
export function selectLocalPreview(id: number, name: string, ids: string[]) {
  const run = previewRun(id, name)
  freezePreviewProgress(id, name)
  return updatePreviewProgress(id, (all) => {
    const progress = all[name]
    if (!progress) throw Error('This agent has no staged preview.')
    if (progress.stages.length && progress.execution === run.sessionId && JSON.stringify(progress.stages.map((stage) => stage.id)) === JSON.stringify(ids)) return { progress, baseline: readPreviewBaseline(run.sessionId) }
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
    const base = baseline ?? { definitionRevision: progress.definitionRevision, generation: progress.generation, stageId: stage, execution: run.sessionId }
    if (base.stageId !== stage) throw Error('Wrong stage.')
    return submitPreviewStage(progress, base, body, { folder: dest })
  })
}

const baselineFile = (run: string) => path.join(BOARD_STATE, 'previews', 'runs', `${run}.json`)
export function savePreviewBaseline(run: string, baseline: PreviewBaseline): void {
  fs.mkdirSync(path.dirname(baselineFile(run)), { recursive: true })
  fs.writeFileSync(baselineFile(run), JSON.stringify(baseline) + '\n')
}
export function readPreviewBaseline(run: string): PreviewBaseline {
  return JSON.parse(fs.readFileSync(baselineFile(run), 'utf8'))
}
export async function activatePreviewRun(id: number, name: string, run: string): Promise<void> {
  const { previewBridge } = await import('../cloud/preview')
  const remote = await previewBridge(name, 'start', { run })
  if (remote?.progress) {
    updatePreviewProgress(id, (all) => { all[name] = remote.progress! })
    if (remote.baseline) savePreviewBaseline(run, remote.baseline)
  } else {
    freezePreviewProgress(id, name)
    updatePreviewProgress(id, (all) => {
      const progress = all[name]
      if (progress?.currentStageId && ['awaiting_confirmation', 'ready'].includes(progress.stages.find((stage) => stage.id === progress.currentStageId)?.status ?? '') && progress.execution !== run) beginPreviewRevision(progress, run)
      if (progress?.currentStageId && !progress.revisionBase) savePreviewBaseline(run, previewBaseline(progress, progress.currentStageId, run))
    })
  }
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
