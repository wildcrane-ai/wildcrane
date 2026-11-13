#!/usr/bin/env node
// Build the launcher and the Runner into dist/, one dependency-free file each. The Runner
// pulls in the CLI's harness, session and Realtime code from ../cli/src, and carries the CLI
// itself as dist/akb/ — the loader, its rules and the package.json it reads (#2020). The plugins'
// component (dist/plugin.mjs) ships in this package too; each plugin carries only start.mjs,
// which runs it from the newest Runner on the computer (#529).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

import { REQUIRE_SHIM } from '../../cli/scripts/shim.mjs'
import { copySkills } from './plugin-skills.mjs'
import { settingsClientPlugin } from './settings-client.mjs'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version
const CLI_DIR = path.join(PKG_DIR, '..', 'cli')
const { version: CLI_VERSION, akbContract: AKB_CONTRACT } = JSON.parse(fs.readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8'))
/** `.json` is text to the Runner's own imports; a package's (the MCP SDK's schemas) stays JSON. */
const PACKAGE_JSON = {
  name: 'package-json',
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/].*\.json$/ }, (args) => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'json' }))
  },
}
const PLUGINS_DIR = path.join(PKG_DIR, '..', 'plugins')
const PLUGIN_DISTS = ['claude-code', 'codex', 'cursor', 'dsh', 'kimi-code', 'grok', 'opencode'].map((host) => path.join(PLUGINS_DIR, host, 'server', 'dist'))
for (const dir of PLUGIN_DISTS) fs.rmSync(dir, { recursive: true, force: true })
copySkills(PLUGINS_DIR)

for (const [entry, outfile] of [
  ['launcher-main.ts', path.join(PKG_DIR, 'dist', 'launcher.mjs')],
  ['main.ts', path.join(PKG_DIR, 'dist', 'runner.mjs')],
  ['flow-worker-main.ts', path.join(PKG_DIR, 'dist', 'flow-worker-main.mjs')],
  ['settings-main.ts', path.join(PKG_DIR, 'dist', 'settings.mjs')],
  ['plugin-main.ts', path.join(PKG_DIR, 'dist', 'plugin.mjs')],
  ['akb-proxy.ts', path.join(PKG_DIR, 'dist', 'akb-proxy.mjs')],
  ...PLUGIN_DISTS.map((dir) => ['plugin-start.ts', path.join(dir, 'start.mjs')]),
]) {
  await esbuild.build({
    entryPoints: [path.join(PKG_DIR, 'src', entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    loader: { '.html': 'text', '.txt': 'text', '.md': 'text', '.svg': 'text', '.tsx': 'text', '.json': 'text' },
    banner: { js: `// wildcrane-runner ${VERSION} — built by runner/scripts/build.mjs. Do not edit.\n${REQUIRE_SHIM}` },
    define: { __RUNNER_VERSION__: JSON.stringify(VERSION), __AKB_VERSION__: JSON.stringify(CLI_VERSION), __AKB_CONTRACT__: String(AKB_CONTRACT) },
    legalComments: 'none',
    plugins: [PACKAGE_JSON, settingsClientPlugin],
  })
  process.stdout.write(`build: wrote ${path.relative(PKG_DIR, outfile)} — ${(fs.statSync(outfile).size / 1024).toFixed(1)} kB\n`)
}

await esbuild.build({
  entryPoints: [path.join(PLUGINS_DIR, 'opencode', 'index.mjs')],
  outfile: path.join(PLUGINS_DIR, 'opencode', 'dist', 'index.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  nodePaths: [path.join(PKG_DIR, 'node_modules')],
  banner: { js: REQUIRE_SHIM }, legalComments: 'none',
})
const v1Skills = path.join(PLUGINS_DIR, 'opencode', 'v1-skills')
fs.rmSync(v1Skills, { recursive: true, force: true })
for (const skill of ['discuss-goal', 'tasks', 'wildcrane']) {
  const name = skill === 'wildcrane' ? skill : `wildcrane-${skill}`
  const target = path.join(v1Skills, name)
  fs.mkdirSync(target, { recursive: true })
  const source = fs.readFileSync(path.join(PLUGINS_DIR, 'opencode', 'skills', skill, 'SKILL.md'), 'utf8')
  fs.writeFileSync(path.join(target, 'SKILL.md'), source.replace(/^name: .+$/m, `name: ${name}`))
}

await buildAkb(path.join(PKG_DIR, 'dist', 'akb'))

async function buildAkb(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  await esbuild.build({
    entryPoints: [path.join(CLI_DIR, 'src', 'kanban.ts')],
    outfile: path.join(dir, 'dist', 'kanban.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    loader: { '.html': 'text', '.txt': 'text', '.md': 'text', '.svg': 'text', '.tsx': 'text', '.json': 'text' },
    // 保持 CLI 构建标记格式。
    banner: { js: `#!/usr/bin/env node\n// ai4kanban ${CLI_VERSION} — built by runner/scripts/build.mjs. Do not edit.\n${REQUIRE_SHIM}` },
    define: { __AKB_BUILT__: 'true' },
    legalComments: 'none',
  })
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.copyFileSync(path.join(CLI_DIR, 'bin', 'ai4kanban.mjs'), path.join(dir, 'bin', 'ai4kanban.mjs'))
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'wildcrane', version: CLI_VERSION, akbContract: AKB_CONTRACT, type: 'module', private: true })}\n`)
  process.stdout.write(`build: wrote ${path.relative(PKG_DIR, dir)}/ — akb ${CLI_VERSION}\n`)
}
