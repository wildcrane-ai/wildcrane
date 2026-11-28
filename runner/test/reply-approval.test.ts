import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { it } from 'node:test'
import { replyApprovalBridge } from '../src/reply-approval'

it('all packaged approval commands defer to the current reply', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-approval-'))
  const board = path.join(root, '.akb', 'kanban')
  fs.mkdirSync(path.join(board, 'todo'), { recursive: true })
  fs.writeFileSync(path.join(board, 'config.md'), '# Config\n')
  fs.writeFileSync(path.join(board, 'todo', '3-test.md'), '---\ntitle: Test\nstudio: coding\nstatus: ready\nquestions: []\n---\n\nApproved scope.\n')
  const calls: unknown[] = []
  const targets = [{ stage: 'design', revision: 1 }, { stage: 'copy', revision: 7 }]
  const approve: Parameters<typeof replyApprovalBridge>[3] = async (comment, task, target) => {
    calls.push({ comment, task, ...target })
    return { ok: true, value: { id: 'reply_1', status: 'pending', task: 'task_3' } }
  }
  const bridge = await replyApprovalBridge('task_3', 3, targets, approve)
  const single = await replyApprovalBridge('task_3', 3, targets.slice(1), approve)
  const run = (args: string[], env = bridge.env) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs'), ...args, '--board', board, '--json'], {
      cwd: root, env: { ...process.env, KANBAN_RUN: '', AI4KANBAN_TASK: 'task_3', AI4KANBAN_REPLY_APPROVAL: env,
        AI4KANBAN_HOME: path.join(root, 'home'), WILDCRANE_HOME: path.join(root, 'home') },
    })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { out += c })
    child.on('close', code => resolve({ code, out }))
  })
  try {
    for (const cmd of ['review', 'approve']) assert.doesNotMatch((await run(['task', cmd, '--help'])).out, /--revision/)
    for (const result of [
      await run(['task', 'approve', '3', '--stage', 'design', '--comment', 'Yes']),
      await run(['task', 'approve', '3'], single.env),
    ]) {
      assert.equal(result.code, 0, result.out)
      assert.match(result.out, /pending/)
      assert.doesNotMatch(result.out, /revision|Approved|approved":true/)
    }
    assert.match((await run(['task', 'approve', '3'])).out, /Specify a review stage with --stage/)
    assert.match((await run(['task', 'approve', '3', '--stage', 'unknown'])).out, /no matching approval target/)
    assert.notEqual((await run(['task', 'approve', '4', '--stage', 'design'])).code, 0)
    assert.deepEqual(calls, [
      { task: '3', stage: 'design', review_revision: 1, comment: 'Yes' },
      { task: '3', stage: 'copy', review_revision: 7, comment: undefined },
    ])
    for (const action of ['approve', 'implement']) assert.notEqual((await run(['raw', 'card', action, '3'])).code, 0)
    const { url } = JSON.parse(bridge.env)
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403)
  } finally { bridge.close(); single.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
