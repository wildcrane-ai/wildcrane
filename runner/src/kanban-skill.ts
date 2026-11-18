import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const SKILL_FOLDERS = ['.claude/skills/kanban', '.agents/skills/kanban']
const MANAGED = /^<!-- ai4kanban \S+ -->$/m

/** Best-effort cleanup of managed files; never follow user links. */
export function removeLegacyKanbanSkill(root: string): void {
  for (const folder of SKILL_FOLDERS) {
    try {
      let at = root
      if (!fs.lstatSync(at, { throwIfNoEntry: false })?.isDirectory()) continue
      let safe = true
      const parts = `${folder}/SKILL.md`.split('/')
      for (const [i, name] of parts.entries()) {
        at = path.join(at, name)
        const stat = fs.lstatSync(at, { throwIfNoEntry: false })
        if (!stat || stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) {
          safe = false
          break
        }
      }
      if (!safe || !MANAGED.test(fs.readFileSync(at, 'utf8'))) continue
      fs.unlinkSync(at)
      const dir = path.dirname(at)
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
    } catch (e) {
      process.stderr.write(`wildcrane: 无法清理 ${folder}：${e instanceof Error ? e.message : String(e)}\n`)
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

/** A cleanup failure leaves the binding intact and is reported internally. */
export function retireKanbanSkill(dir: string): void {
  try {
    keepOutOfGit(dir)
    removeLegacyKanbanSkill(dir)
  } catch (e) {
    process.stderr.write(`wildcrane: ${e instanceof Error ? e.message : String(e)}\n`)
  }
}
