#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

import { REQUIRE_SHIM } from '../../cli/scripts/shim.mjs'
import { selectTests } from '../../cli/scripts/test-options.mjs'
import { packageJsonPlugin } from './package-json.mjs'
import { settingsClientPlugin } from './settings-client.mjs'

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIR = path.join(PKG_DIR, 'test')
const files = fs.readdirSync(TEST_DIR).filter(file => file.endsWith('.test.ts'))
const groups = {
  'codex-server.test.ts': ['codex-server.test.ts', 'codex-server-idle.test.ts'],
  'runner.test.ts': files.filter(file => file.startsWith('runner-') && file !== 'runner-log.test.ts'),
  'flow-worker.test.ts': files.filter(file => file.startsWith('flow-worker-')),
}
const requested = process.argv.slice(2)
const { tests: selected, nodeArgs } = selectTests([...files, ...Object.keys(groups)], requested)
const tests = [...new Set(selected.flatMap(file => groups[file] ?? file))]
if (!requested.length) {
  const sizes = new Map(tests.map(file => [file, fs.statSync(path.join(TEST_DIR, file)).size]))
  tests.sort((a, b) => sizes.get(b) - sizes.get(a))
}
// Node sorts test paths. Give larger files the first slots in a full run.
const entries = tests.map((file, index) => ({
  in: path.join(TEST_DIR, file),
  out: (requested.length ? '' : `${String(index).padStart(3, '0')}-`) + file.slice(0, -3),
}))
const concurrency = Number(process.env.RUNNER_TEST_CONCURRENCY ?? Math.min(os.availableParallelism(), 7))
if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
  throw new Error('RUNNER_TEST_CONCURRENCY must be a positive integer.')
}

// The SQL recovery gate supplies its own AKB fixture and needs no release artifacts.
if (tests.some(file => file !== 'update-service.test.ts')) {
  const build = spawnSync(process.execPath, [path.join(PKG_DIR, 'scripts', 'build.mjs')], { stdio: 'inherit' })
  if (build.error) throw build.error
  if (build.status !== 0) process.exit(build.status ?? 1)
}

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcrane-test-'))
try {
  const needsFlowHost = tests.some(file => file.startsWith('flow-worker-') || file === 'codex-lifecycle.test.ts')
  const host = needsFlowHost ? path.join(TEST_DIR, 'fixtures', 'flow-host.ts') : undefined
  await esbuild.build({
    entryPoints: [...entries, ...(host ? [{ in: host, out: 'fixtures/flow-host' }] : [])],
    outdir: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outExtension: { '.js': '.mjs' },
    loader: { '.html': 'text', '.txt': 'text', '.md': 'text', '.svg': 'text', '.tsx': 'text', '.json': 'text' },
    define: { __RUNNER_VERSION__: '"0.0.0-test"', __AKB_VERSION__: '"0.0.0-test"', __AKB_CONTRACT__: '1' },
    legalComments: 'none',
    banner: { js: REQUIRE_SHIM },
    plugins: [packageJsonPlugin, settingsClientPlugin],
  })

  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AI4KANBAN_|KANBAN_|WILDCRANE_)/.test(key)))
  const run = spawnSync(process.execPath, [
    '--test', `--test-concurrency=${concurrency}`, '--import', new URL('./test-home.mjs', import.meta.url).href,
      ...nodeArgs, ...entries.map(entry => path.join(output, `${entry.out}.mjs`)),
  ], {
    cwd: PKG_DIR,
    stdio: 'inherit',
    env: {
      ...inherited,
      WILDCRANE_TEST_HOME_ROOT: output,
      AI4KANBAN_STUDIOS: path.join(PKG_DIR, '..', 'official'),
      AI4KANBAN_PATH_ONLY: '1',
      WILDCRANE_CODEX_IDLE_MS: '200',
      RUNNER_DIST: path.join(PKG_DIR, 'dist'),
      RUNNER_TEST_FLOW_HOST: host ? path.join(output, 'fixtures', 'flow-host.mjs') : '',
    },
  })
  if (run.error) throw run.error
  process.exitCode = run.status ?? 1
} finally {
  fs.rmSync(output, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}
