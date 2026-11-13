// Real host + packed releases, isolated HOME and registry; no user configuration or Cloud writes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const option = (key) => process.argv[process.argv.indexOf(key) + 1]
const executable = path.resolve(option('--opencode'))
const pkg = path.resolve(option('--package'))
const previous = path.resolve(option('--previous'))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-opencode-699-'))
const command = (exe, args, env, cwd) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (x) => { stdout += x })
  child.stderr.on('data', (x) => { stderr += x })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  child.on('error', reject)
  child.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(stdout.trim()) : reject(new Error(`${args.join(' ')}: ${stderr}`)) })
})
const packInfo = async (file) => JSON.parse(await command('tar', ['-xOf', file, 'package/package.json'], process.env, root))
const old = await packInfo(previous), next = await packInfo(pkg)
let latest = old.version
const registry = http.createServer((req, res) => {
  if (req.url === '/wildcrane-opencode') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name: next.name, 'dist-tags': { latest }, versions: Object.fromEntries([old, next].map((p) => [p.version, { ...p, dist: { tarball: `http://127.0.0.1:${registry.address().port}/${p.version}.tgz` } }])) }))
  } else if (req.url === `/${old.version}.tgz` || req.url === `/${next.version}.tgz`) {
    fs.createReadStream(req.url === `/${old.version}.tgz` ? previous : pkg).pipe(res)
  } else { res.statusCode = 404; res.end('not found') }
})
await new Promise((r) => registry.listen(0, '127.0.0.1', r))
const home = path.join(root, 'home'), dir = path.join(root, 'project'), configDir = path.join(root, 'config/opencode')
for (const p of [home, dir, configDir, path.join(root, 'bin')]) fs.mkdirSync(p, { recursive: true })
fs.symlinkSync(executable, path.join(root, 'bin/opencode'))
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), WILDCRANE_HOME: path.join(root, 'wildcrane'),
  WILDCRANE_RUNNER_DIR: path.resolve('runner'), OPENCODE_SERVER_PASSWORD: 'disposable-test',
  npm_config_registry: `http://127.0.0.1:${registry.address().port}`, npm_config_cache: path.join(root, 'npm'),
  PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` }
for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG_DIR']) delete env[key]
const other = path.join(root, 'other')
fs.mkdirSync(other)
fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'other-plugin', type: 'module', exports: './index.js' }))
fs.writeFileSync(path.join(other, 'index.js'), 'export default {id:"other-plugin",setup(){}}')
const configFile = path.join(configDir, 'opencode.jsonc')
const before = { instructions: ['Keep this instruction'], permissions: { wildcrane_status: 'ask' }, plugins: [pathToFileURL(other).href] }
fs.writeFileSync(configFile, '// Keep this comment\n' + JSON.stringify(before))
const userFiles = [path.join(home, '.agents/skills/personal/SKILL.md'), path.join(dir, '.opencode/skills/wildcrane-tasks/SKILL.md')]
for (const file of userFiles) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `---\nname: ${file.includes('personal') ? 'personal' : 'wildcrane-tasks'}\ndescription: User skill\n---\nPreserve this user skill.\n`)
}
const contents = userFiles.map((f) => fs.readFileSync(f, 'utf8'))
const read = () => JSON.parse(fs.readFileSync(configFile, 'utf8').replace('// Keep this comment\n', ''))
const keep = () => {
  const text = fs.readFileSync(configFile, 'utf8')
  assert.match(text, /Keep this comment/)
  const config = read()
  assert.deepEqual(config.instructions, before.instructions)
  assert.deepEqual(config.permissions, before.permissions)
  assert.equal(config.plugins[0], before.plugins[0])
  userFiles.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), contents[i]))
}
const manage = async (...args) => { const result = await command('npm', ['exec', '--yes', '--package', pkg, '--', 'wildcrane-opencode', ...args], env, dir); keep(); console.log(`${args.join(' ')}: ${result}`); return result }
let child
try {
  console.log(`Host: ${await command(executable, ['--version'], env, dir)}; packages: ${old.version} → ${next.version}`)
  await manage('install')
  assert.match(await manage('update'), /up to date/)
  latest = next.version
  await manage('update')
  assert.match(read().plugins[1], new RegExp(`/latest/${next.version}/`))
  await manage('install', old.version)
  assert.match(await manage('update'), /pinned/)
  assert.match(read().plugins[1], new RegExp(`/pinned/${old.version}/`))
  await manage('install', next.version)
  await manage('install')
  const beforeFailure = fs.readFileSync(configFile, 'utf8')
  await assert.rejects(manage('install', '9.9.9'), /npm install failed/)
  assert.equal(fs.readFileSync(configFile, 'utf8'), beforeFailure)
  keep()
  console.log('Download failure: npm cause reported; configured package retained')
  const socket = net.createServer()
  await new Promise((r) => socket.listen(0, '127.0.0.1', r))
  const port = socket.address().port
  await new Promise((r) => socket.close(r))
  child = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = ''
  child.stdout.on('data', (x) => { logs += x })
  child.stderr.on('data', (x) => { logs += x })
  const get = async (endpoint) => {
    const url = new URL(`http://127.0.0.1:${port}${endpoint}`)
    url.searchParams.set('location[directory]', dir)
    const response = await fetch(url, { headers: { authorization: `Basic ${Buffer.from('opencode:disposable-test').toString('base64')}` }, signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    return response.json()
  }
  let active = false
  for (let i = 0; i < 180; i++) {
    try { active = (await get('/api/plugin')).data.some((p) => p.id === 'wildcrane' && p.state.status === 'active') } catch {}
    if (active || child.exitCode !== null) break
    await new Promise((r) => setTimeout(r, 500))
  }
  assert.ok(active, `Plugin activation failed: ${logs}`)
  const skills = (await get('/api/skill')).data
  for (const name of ['wildcrane', 'wildcrane-discuss-goal', 'wildcrane-tasks']) assert.ok(skills.some((s) => s.name === name), `Missing ${name}`)
  assert.match(skills.find((s) => s.name === 'wildcrane-tasks').content, /Preserve this user skill/)
  console.log('Native activation and project skill precedence: passed')
  await manage('remove')
  assert.deepEqual(read(), before)
  console.log('Configuration and user skills preserved at every step; no Cloud writes.')
} finally {
  if (child && child.exitCode === null) {
    const exit = new Promise((r) => child.on('exit', r))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exit
    clearTimeout(timer)
  }
  await command(executable, ['service', 'stop'], env, dir).catch(() => {})
  await new Promise((r) => registry.close(r))
  fs.rmSync(root, { recursive: true, force: true })
}
