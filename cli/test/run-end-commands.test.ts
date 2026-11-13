// A run whose agent exits on its own ends the commands it left in the background (#1499).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { completeDelivery } from '../src/lib/agent/complete.ts'
import { RUN_ENV } from '../src/lib/agent/env.ts'
import { markEnv, runMark } from '../src/lib/agent/stop.ts'
import { afterEach, beforeEach, it } from 'node:test'

import { patch } from '../src/lib/agent/sessions.ts'
import { startRun } from '../src/lib/agent/start.ts'
import { readRuns } from '../src/lib/agent/store.ts'
import { watchRun } from '../src/lib/agent/watch.ts'
import { setBoardProvider } from '../src/lib/board/index.ts'
import { pidAlive } from '../src/lib/lock.ts'
import { setBoardRoot } from '../src/lib/paths.ts'
import { forgetMachineState, move, uiConfigOf } from './helpers/board.ts'

let root = ''

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-run-end-'))
  forgetMachineState(root)
  setBoardRoot(root)
  setBoardProvider(null)
  fs.mkdirSync(path.join(root, 'docs', 'kanban', 'todo'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs', 'kanban', 'next-id'), '1\n')
  fs.writeFileSync(path.join(root, 'docs', 'kanban', 'todo', 'README.md'), '# Tasks\n')
  await move(root, ['create', '--title', 'Card one'])
})

afterEach(() => {
  forgetMachineState(root)
  fs.rmSync(root, { recursive: true, force: true })
})

it('ends what a finished run left in the background, even one holding its output', { skip: process.platform === 'win32' }, async () => {
  const left = path.join(root, 'left')
  const file = path.join(root, 'agent.mjs')
  // The command keeps the agent's stdout, so without the kill `close` would wait on it.
  fs.writeFileSync(
    file,
    `import { spawn } from 'node:child_process'
import fs from 'node:fs'
const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'inherit' })
c.unref()
fs.writeFileSync(${JSON.stringify(left)}, String(c.pid))
console.log(JSON.stringify({ type: 'result', result: 'ok' }))
`,
  )
  fs.writeFileSync(
    uiConfigOf(root, 'docs', 'kanban'),
    JSON.stringify({ runtimes: [{ id: 'global', name: 'Global default', harness: 'claude-code', settings: { command: `node ${file}` } }] }),
  )
  const started = await startRun({ action: 'clarify', id: 1 })
  if ('error' in started) throw new Error(started.error)
  const run = started.run
  patch(run.sessionId, (r) => { r.pid = process.pid })
  fs.writeFileSync(run.logPath, '')

  const t = Date.now()
  await watchRun(run.sessionId, async () => ({ error: 'no resume' }))
  const pid = Number(fs.readFileSync(left, 'utf8'))
  try {
    assert.ok(Date.now() - t < 20_000)
    assert.equal(readRuns().find((r) => r.sessionId === run.sessionId)?.status, 'done')
    assert.equal(pidAlive(pid), false)
  } finally {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
})

for (const background of [true, false]) it(`cleans a completed task with background=${background} without stopping other work (#715)`, { timeout: 30_000 }, async () => {
  const info = path.join(root, 'preview.json')
  const done = path.join(root, 'completed')
  const file = path.join(root, 'completed-agent.mjs')
  const service = `
    const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio:'inherit'});
    process.on('SIGTERM',()=>{});
    const server = require('node:http').createServer((q,r)=>r.end('preview'));
    server.listen(0,'127.0.0.1',()=>require('node:fs').writeFileSync(${JSON.stringify(info)},JSON.stringify({pid:process.pid,child:child.pid,port:server.address().port})));
  `
  fs.writeFileSync(file, `
    import {spawn} from 'node:child_process';
    import fs from 'node:fs';
    if (${background}) spawn(process.execPath,['-e',${JSON.stringify(service)}],{detached:true,stdio:'inherit'}).unref();
    else fs.writeFileSync(${JSON.stringify(info)},'{}');
    process.stdin.resume();
    const out = e => console.log(JSON.stringify(e));
    const timer=setInterval(()=>{
      if(!fs.existsSync(${JSON.stringify(done)}))return;
      clearInterval(timer);
      out({type:'system',subtype:'init',model:'test'});
      if (${background}) out({type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'preview'}]});
      out({type:'result',result:'SHIPPED'});
    },50);
  `)
  fs.writeFileSync(uiConfigOf(root, 'docs', 'kanban'), JSON.stringify({runtimes:[{id:'global',name:'Global default',harness:'claude-code',settings:{command:`node ${file}`}}]}))
  const started = await startRun({action:'implement',id:1})
  if ('error' in started) throw Error(started.error)
  const run = started.run
  patch(run.sessionId, r => {r.pid=process.pid})
  const card = path.join(root,'docs/kanban/todo/1-card-one.md')
  fs.writeFileSync(card,fs.readFileSync(card,'utf8').replaceAll('- [ ]','- [x]'))
  const outsiders = [undefined,markEnv(process.env,runMark('other-task'))].map(env => spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env,stdio:'ignore'}))
  let preview: {pid?:number;child?:number;port?:number} = {}
  const watched = watchRun(run.sessionId,async()=>({error:'no resume'}))
  try {
    const until = Date.now()+5000
    while(!fs.existsSync(info) && Date.now()<until) await new Promise(r=>setTimeout(r,50))
    preview=JSON.parse(fs.readFileSync(info,'utf8'))
    const previous=process.env[RUN_ENV]
    try {
      process.env[RUN_ENV]=run.sessionId
      assert.equal(completeDelivery(run.deliveryId!).finished,true)
    } finally {
      if(previous===undefined) delete process.env[RUN_ENV]
      else process.env[RUN_ENV]=previous
    }
    fs.writeFileSync(done,'')
    assert.equal(await watched,0)
    assert.equal(readRuns().find(r=>r.sessionId===run.sessionId)?.status,'done')
    for(const pid of [preview.pid,preview.child]) if(pid) assert.equal(pidAlive(pid),false,`left pid ${pid}`)
    for(const child of outsiders) assert.equal(pidAlive(child.pid!),true)
    if(preview.port) {
      const server=net.createServer()
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(preview.port,'127.0.0.1',resolve)})
      await new Promise<void>(resolve=>server.close(()=>resolve()))
    }
  } finally {
    for(const pid of [preview.pid,preview.child,...outsiders.map(c=>c.pid)]) if(pid) try{process.kill(pid,'SIGKILL')}catch{}
  }
})
