import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { machineHome } from '../../machine/home'

export function acpCostFile(tool: string, cwd: string, session: string): string {
  const key = createHash('sha256').update(JSON.stringify([tool, cwd, session])).digest('hex')
  return path.join(machineHome(), 'usage', 'acp', `${key}.json`)
}

export function readAcpCost(file: string): number | undefined {
  try {
    const n = JSON.parse(fs.readFileSync(file, 'utf8'))
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
  } catch { return undefined }
}

export function saveAcpCost(file: string, cost: number | undefined): void {
  if (cost === undefined) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(cost), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch { /* The agent's reported price remains valid if its snapshot cannot be saved. */ }
}
