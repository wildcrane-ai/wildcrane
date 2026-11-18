#!/usr/bin/env node
// node cli/scripts/migrate-coding-memory.mjs --input snapshot.json --project prj_… --output report.json [--apply-local board]
// The snapshot uses full Cloud paths; the caller obtains it through the authorized Board API.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { codingMemoryMoves, memoryHash } from '../src/lib/shared/coding-memory-migration.ts'

const { values } = parseArgs({ options: { input: { type: 'string' }, project: { type: 'string' }, output: { type: 'string' }, 'apply-local': { type: 'string' } } })
if (!values.input || !values.project || !values.output || !/^prj_[\w-]+$/.test(values.project)) throw Error('Name --input, --project and --output.')
const snapshot = JSON.parse(fs.readFileSync(values.input, 'utf8'))
const files = new Map(snapshot.files.filter(f => f.content !== null).map(f => [f.path, f.content]))
const moves = codingMemoryMoves(files, values.project)
const result = { project: values.project, moves, verified: false }
fs.writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n')
if (values['apply-local']) {
  const board = path.resolve(values['apply-local'])
  const root = `projects/${values.project}/`
  const local = p => {
    const relative = p.startsWith(root) ? p.slice(root.length) : p
    if (!relative.startsWith('memory/') || relative.split('/').some(v => !v || v === '.' || v === '..') || relative.includes('\\')) throw Error(`Invalid memory path: ${p}`)
    return path.join(board, relative)
  }
  const sources = new Map()
  for (const move of moves) {
    const file = local(move.source)
    sources.set(file, [...(sources.get(file) ?? []), files.get(move.source)])
  }
  for (const [file, contents] of sources) {
    if (fs.existsSync(file) && !contents.includes(fs.readFileSync(file, 'utf8'))) throw Error(`Unresolved local source: ${file}`)
  }
  for (const move of moves) {
    if (move.status === 'blocked') throw Error(`Unresolved source conflict: ${move.source}`)
    const target = local(move.target), content = files.get(move.source)
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== content) throw Error(`Local target changed: ${target}`)
  }
  for (const move of moves) {
    const target = local(move.target)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (!fs.existsSync(target)) fs.writeFileSync(target, files.get(move.source), { flag: 'wx' })
    if (memoryHash(fs.readFileSync(target, 'utf8')) !== move.hash) throw Error(`Verification failed: ${move.target}`)
  }
  for (const move of moves) fs.rmSync(local(move.source), { force: true })
  for (const move of moves) {
    let dir = path.dirname(local(move.source))
    while (dir !== path.join(board, 'memory')) {
      try { fs.rmdirSync(dir) } catch { break }
      dir = path.dirname(dir)
    }
  }
  result.verified = true
  fs.writeFileSync(values.output, JSON.stringify(result, null, 2) + '\n')
}
console.log(JSON.stringify({ files: moves.length, conflicts: moves.filter(m => m.status === 'conflict').length, blocked: moves.filter(m => m.status === 'blocked').length, verified: result.verified }))
