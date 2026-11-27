import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { runnerHome } from '../src/home'
import { logRunner, startRunnerLogMaintenance } from '../src/runner-log'

const limit = 5 * 1024 * 1024
const logs = path.join(runnerHome(), 'logs')
const current = path.join(logs, 'runner.log')
const archive = (date: string, seq: number) => `${current}.${date}.${seq}`
const record = (time: string) => JSON.stringify({ time, component: 'runner', event: 'starting' })
const append = () => logRunner('runner', 'starting')

function seed(file: string, time: string, size = record(time).length + 1): void {
  fs.writeFileSync(file, record(time).padEnd(size - 1) + '\n')
}

function records(file: string) {
  return fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
}

const clean = () => fs.rmSync(logs, { recursive: true, force: true })
const writer = (start: number) => promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), '--write', String(start)])

if (process.argv[2] === '--write') {
  const start = Number(process.argv[3])
  for (let task = start; task < start + 24; task++) logRunner('board', 'failed', { stage: 'push', code: 'conflict', task })
  process.exit(0)
}

it('rotates at the byte and UTC day boundaries, and expires only Runner logs at startup and while idle', (t) => {
  const time = '2026-04-07T23:59:30.000Z'
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.parse(time) })
  clean()
  fs.mkdirSync(logs)
  seed(archive('2026-03-31', 1), '2026-03-31T00:00:00.000Z')
  seed(archive('2026-04-01', 1), '2026-04-01T00:00:00.000Z')
  const other = path.join(logs, 'runner.log.manual')
  fs.writeFileSync(other, 'keep')
  seed(current, time, limit - Buffer.byteLength(record(time) + '\n'))

  append()
  assert.equal(fs.statSync(current).size, limit)
  assert.ok(!fs.existsSync(archive('2026-03-31', 1)))
  assert.ok(fs.existsSync(archive('2026-04-01', 1)))
  assert.ok(!fs.existsSync(archive('2026-04-07', 1)))

  append()
  assert.equal(fs.statSync(archive('2026-04-07', 1)).size, limit)
  assert.deepEqual(records(current), [JSON.parse(record(time))])
  if (process.platform !== 'win32') assert.equal(fs.statSync(current).mode & 0o777, 0o600)

  startRunnerLogMaintenance()
  t.mock.timers.tick(60_000)
  assert.ok(!fs.existsSync(current))
  assert.ok(!fs.existsSync(archive('2026-04-01', 1)))
  assert.deepEqual(records(archive('2026-04-07', 2)), [JSON.parse(record(time))])
  assert.equal(fs.readFileSync(other, 'utf8'), 'keep')

  append()
  assert.equal(records(current)[0].time, '2026-04-08T00:00:30.000Z')
})

it('keeps complete records and only three archives when processes rotate the same log', async () => {
  clean()
  const now = new Date().toISOString()
  const date = now.slice(0, 10)
  append()
  if (process.platform !== 'win32') assert.equal(fs.statSync(logs).mode & 0o777, 0o700)
  for (const n of [1, 2, 3]) seed(archive(date, n), now, limit)
  seed(current, now, limit - 1024)

  const starts = [1, 25, 49, 73]
  const children = await Promise.all(starts.map(writer))
  assert.ok(children.every(result => !result.stdout && !result.stderr))
  const names = fs.readdirSync(logs).sort()
  assert.deepEqual(names, ['runner.log', ...[2, 3, 4].map(n => path.basename(archive(date, n)))])
  const tasks = names.flatMap(name => {
    const file = path.join(logs, name)
    assert.ok(fs.statSync(file).size <= limit)
    return records(file).flatMap(record => record.task ? [record.task] : [])
  }).sort((a, b) => a - b)
  assert.deepEqual(tasks, Array.from({ length: 96 }, (_, i) => i + 1))
})

it('rate limits failures to write and resumes logging when the directory is usable', async () => {
  clean()
  fs.writeFileSync(logs, 'blocked')
  const { stdout, stderr } = await writer(1)
  assert.equal(stdout, '')
  assert.equal(stderr, 'WildCrane could not write its local Runner log.\n')
  assert.equal(fs.readFileSync(logs, 'utf8'), 'blocked')
  clean()
  append()
  assert.equal(records(current)[0].event, 'starting')
})
