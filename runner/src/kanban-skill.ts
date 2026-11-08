import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import note from '../../skill/SKILL.md'

/** The kanban skill the Runner installs in a project for akb's runs and the person's sessions. */
export const SKILL_FOLDERS = ['.claude/skills/kanban', '.agents/skills/kanban']

const CONTENT = `${note.trimEnd()}\n\n<!-- ai4kanban managed -->\n`
const MANAGED = /^<!-- ai4kanban \S+ -->$/m

/** 只刷新受管理正文；旧配置及其他文件留在原处。 */
export function prepareKanbanSkill(root: string): void {
  for (const folder of SKILL_FOLDERS) {
    const dir = path.join(root, folder)
    const file = path.join(dir, 'SKILL.md')
    try {
      let linked = false
      let at = root
      for (const name of `${folder}/SKILL.md`.split('/')) {
        at = path.join(at, name)
        if (fs.lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) linked = true
      }
      const held = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
      const exists = fs.lstatSync(dir, { throwIfNoEntry: false }) !== undefined
      if (linked || (exists && !MANAGED.test(held ?? ''))) {
        if (!held?.trim()) throw new Error('用户自有目录或符号链接中缺少可读的 SKILL.md')
        continue
      }
      if (held !== CONTENT) {
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(file, CONTENT)
      }
    } catch (e) {
      throw new Error(`无法准备 ${folder}：${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/** `.akb/` never reaches the project's history: excluded locally unless already ignored. */
export function keepOutOfGit(dir: string, folders: string[] = SKILL_FOLDERS): void {
  const git = (...args: string[]) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
  const inside = git('rev-parse', '--git-path', 'info/exclude')
  if (inside.status !== 0) return
  const missing = ['.akb/', ...folders.map((f) => `${f}/`)].filter((p) => git('check-ignore', '-q', p).status !== 0)
  if (!missing.length) return
  const exclude = path.resolve(dir, inside.stdout.trim())
  fs.mkdirSync(path.dirname(exclude), { recursive: true })
  const held = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
  fs.writeFileSync(exclude, `${held}${held && !held.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`)
}

/** A folder just bound: its sessions get the skill at once; a failure leaves the binding alone. */
export function installKanbanSkill(dir: string): void {
  try {
    keepOutOfGit(dir)
    prepareKanbanSkill(dir)
  } catch (e) {
    process.stderr.write(`wildcrane: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}
