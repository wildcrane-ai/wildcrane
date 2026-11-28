import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, afterEach, beforeEach } from 'node:test'
import { once } from 'node:events'
import { codexServer } from '../src/codex-server'
import { nativeDirectory, readPrivate, type NativeBackend } from '../src/codex-native'
import { connect } from '../../cli/src/lib/agent/wire/rpc'

const previous = process.env.WILDCRANE_HOME
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-test-'))
const fake = path.join(root, 'codex')
const calls = path.join(root, 'calls.jsonl')
const peers = new Set<ChildProcessWithoutNullStreams>()
let manager: Awaited<ReturnType<typeof codexServer>>
beforeEach(async () => {
 process.env.WILDCRANE_HOME = root; process.env.FAKE_CODEX_CALLS = calls
 fs.copyFileSync(path.join(process.env.RUNNER_DIST!, '../test/fake-codex-native.mjs'), fake);fs.chmodSync(fake, 0o755)
 await openManager()
})
afterEach(async () => { for(const child of peers){if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.stdin.end();await done;}}peers.clear();await manager.shutdown();fs.rmSync(nativeDirectory(),{recursive:true,force:true}) })
after(() => { process.env.WILDCRANE_HOME=previous;delete process.env.FAKE_CODEX_CALLS;fs.rmSync(root,{recursive:true,force:true}) })
const read = () => fs.existsSync(calls)?fs.readFileSync(calls,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]
const backends = () => fs.readdirSync(nativeDirectory()).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).map(name=>readPrivate<NativeBackend>(path.join(nativeDirectory(),name))!)
async function peer(args:string[]=[], local:NodeJS.ProcessEnv={}) {
 const child=spawn(process.execPath,[path.join(process.env.RUNNER_DIST!,'codex-proxy.mjs'),fake,'app-server',...args],{env:{...process.env,...manager.env,...local},stdio:['pipe','pipe','pipe']})
 peers.add(child);let error='';child.stderr.on('data',s=>error+=s);const notifications:any[]=[]
 const rpc=connect(child.stdout,child.stdin,message=>notifications.push(message))
 const hello=await rpc.call('initialize',{})
 return {child,rpc,hello,notifications,async close(){if(child.exitCode!==null||child.signalCode!==null)return;const ended=once(child,'close');child.stdin.end();await ended;assert.equal(child.exitCode,0,error)}}
}

export async function openManager() {
 manager = await codexServer()
}

export { root, fake, calls, peers, manager, read, backends, peer }
