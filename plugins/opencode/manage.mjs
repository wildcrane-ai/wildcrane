#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyEdits, modify, parse, parseTree, findNodeAtLocation, createScanner, SyntaxKind } from 'jsonc-parser'

const name = 'wildcrane-opencode'
const exact = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/
const target = (entry) => typeof entry === 'string' ? entry : entry?.package
const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`)
  return result.stdout.trim()
}
const npm = (...args) => run('npm', args)

// jsonc-parser's array removal can leave an object delimiter.
function removeEntry(text, index) {
  const array = findNodeAtLocation(parseTree(text), ['plugins'])
  const node = array.children[index]
  const scanner = createScanner(text, true)
  scanner.setPosition(array.offset + 1)
  const commas = []
  while (scanner.scan() !== SyntaxKind.EOF) {
    const offset = scanner.getTokenOffset()
    if (offset >= array.offset + array.length) break
    if (scanner.getToken() === SyntaxKind.CommaToken && (offset < node.offset || offset >= node.offset + node.length)) commas.push(offset)
  }
  const previous = array.children[index - 1]
  const comma = previous ? commas.find((offset) => offset >= previous.offset + previous.length && offset < node.offset)
    : commas.find((offset) => offset >= node.offset + node.length)
  return applyEdits(text, [{ offset: node.offset, length: node.length, content: '' }, ...(comma === undefined ? [] : [{ offset: comma, length: 1, content: '' }])])
}

function readConfig(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}\n'
  const errors = []
  const config = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !config || typeof config !== 'object' || Array.isArray(config) ||
      (config.plugins !== undefined && !Array.isArray(config.plugins))) throw new Error(`Invalid OpenCode configuration: ${file}`)
  return { text, config }
}

export function manage(action, version, { directory = process.env.OPENCODE_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'opencode'), execute = run, registry = npm } = {}) {
  if (!['install', 'update', 'remove'].includes(action) || (version !== undefined && (action !== 'install' || !exact.test(version)))) {
    throw new Error('Usage: wildcrane-opencode install [version] | update | remove')
  }
  const host = execute('opencode', ['--version']).match(/(?:^|v)(\d+)\.(\d+)\.(\d+)/)
  if (!host || Number(host[1]) < 2 || (Number(host[1]) === 2 && (Number(host[2]) < 2 || (Number(host[2]) === 2 && Number(host[3]) < 7)))) {
    throw new Error('OpenCode 2.2.7+ is required. Update OpenCode, then retry.')
  }
  const files = ['opencode.jsonc', 'opencode.json'].map((f) => path.join(directory, f)).filter((f) => fs.existsSync(f))
  if (!files.length) files.push(path.join(directory, 'opencode.jsonc'))
  const documents = files.map((file) => ({ file, ...readConfig(file) }))
  const storage = path.join(directory, 'wildcrane', 'packages')
  const owned = (entry) => {
    const spec = target(entry)
    if (typeof spec !== 'string') return false
    if (spec === name || spec.startsWith(`${name}@`)) return true
    if (!spec.startsWith('file:')) return false
    try {
      const relative = path.relative(storage, fileURLToPath(spec))
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
    } catch { return false }
  }
  const matches = documents.flatMap((doc) => (doc.config.plugins ?? []).filter(owned))
  if (action !== 'install' && !matches.length) throw new Error(`WildCrane is not configured in ${directory}. Run wildcrane-opencode install.`)
  const current = target(matches[0])
  const pinned = matches.some((entry) => {
    const spec = target(entry)
    return spec.startsWith(`${name}@`) && exact.test(spec.slice(name.length + 1)) ||
      spec.startsWith('file:') && path.relative(storage, fileURLToPath(spec)).split(path.sep)[0] === 'pinned'
  })
  if (action === 'update' && pinned) return 'WildCrane is pinned. Use install <version> to change it, or install to follow updates.'

  let entry
  if (action !== 'remove') {
    const wanted = version ?? registry('view', `${name}@latest`, 'version')
    if (!exact.test(wanted)) throw new Error(`npm returned an invalid WildCrane version: ${wanted}`)
    const destination = path.join(storage, version ? 'pinned' : 'latest', wanted)
    const installed = path.join(destination, 'node_modules', name)
    const manifest = path.join(installed, 'package.json')
    if (!fs.existsSync(manifest)) {
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.download-'))
      try {
        registry('install', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--save-exact', `${name}@${wanted}`)
        const pkg = JSON.parse(fs.readFileSync(path.join(stage, 'node_modules', name, 'package.json'), 'utf8'))
        if (pkg.name !== name || pkg.version !== wanted || !fs.existsSync(path.join(stage, 'node_modules', name, 'dist/index.mjs'))) throw new Error('Downloaded WildCrane package is incomplete or has the wrong version.')
        fs.renameSync(stage, destination)
      } finally { fs.rmSync(stage, { recursive: true, force: true }) }
    }
    const cached = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    if (cached.name !== name || cached.version !== wanted || !fs.existsSync(path.join(installed, 'dist/index.mjs'))) throw new Error(`Invalid cached WildCrane package: ${installed}`)
    entry = pathToFileURL(installed).href
  }
  // Download first; refuse to overwrite edits made while npm was running.
  for (const doc of documents) if (readConfig(doc.file).text !== doc.text) throw new Error('OpenCode configuration changed during download. Retry the command.')
  let inserted = false
  for (const doc of documents) {
    let text = doc.text
    const plugins = doc.config.plugins ?? []
    for (let i = plugins.length - 1; i >= 0; i--) {
      if (!owned(plugins[i])) continue
      const replace = action !== 'remove' && !inserted
      inserted ||= replace
      text = replace ? applyEdits(text, modify(text, typeof plugins[i] === 'object' ? ['plugins', i, 'package'] : ['plugins', i], entry, {})) : removeEntry(text, i)
    }
    if (action !== 'remove' && !inserted && doc === documents.at(-1)) {
      text = applyEdits(text, modify(text, doc.config.plugins ? ['plugins', -1] : ['plugins'], doc.config.plugins ? entry : [entry], { formattingOptions: { tabSize: 2, insertSpaces: true } }))
      inserted = true
    }
    if (text === doc.text) continue
    fs.mkdirSync(directory, { recursive: true })
    const temporary = `${doc.file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, text, { mode: fs.existsSync(doc.file) ? fs.statSync(doc.file).mode & 0o777 : 0o600 })
    fs.renameSync(temporary, doc.file)
  }
  if (action === 'remove') return 'WildCrane removed. Reopen OpenCode.'
  return current === entry ? 'WildCrane is up to date.' : `WildCrane installed${version ? ` (pinned to ${version})` : ''}. Reopen OpenCode.`
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 4) throw new Error('Usage: wildcrane-opencode install [version] | update | remove')
    console.log(manage(process.argv[2], process.argv[3]))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
