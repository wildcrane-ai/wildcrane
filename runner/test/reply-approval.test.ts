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
  let calls = 0
  const bridge = await replyApprovalBridge('task_3', 3, async () => {
    calls++
    return { ok: true, value: { id: 'reply_1', status: 'pending', task: 'task_3' } }
  })
  const run = (args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [path.join(process.env.RUNNER_DIST!, 'akb/bin/ai4kanban.mjs'), ...args, '--board', board, '--json'], {
      cwd: root, env: { ...process.env, KANBAN_RUN: '', AI4KANBAN_TASK: 'task_3', AI4KANBAN_REPLY_APPROVAL: bridge.env,
        AI4KANBAN_HOME: path.join(root, 'home'), WILDCRANE_HOME: path.join(root, 'home') },
    })
    let out = ''
    child.stdout.on('data', c => { out += c })
    child.stderr.on('data', c => { out += c })
    child.on('close', code => resolve({ code, out }))
  })
  try {
    for (const args of [['task', 'approve', '3'], ['raw', 'card', 'approve', '3'], ['raw', 'card', 'implement', '3']]) {
      const result = await run(args)
      assert.equal(result.code, 0, result.out)
      assert.match(result.out, /pending/)
      assert.doesNotMatch(result.out, /Approved|approved":true/)
    }
    assert.equal(calls, 3)
    const refused = await run(['task', 'approve', '4'])
    assert.notEqual(refused.code, 0)
    assert.equal(calls, 3)
    const { url } = JSON.parse(bridge.env)
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403)
  } finally { bridge.close(); fs.rmSync(root, { recursive: true, force: true }) }
})
