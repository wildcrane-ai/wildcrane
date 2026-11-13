import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startRunner } from '../../src/connect'
import { reclaimFlowWorkerAfterExit, runFlowWorker } from '../../src/flow-worker'
import { runnerHome, useRunnerHome } from '../../src/home'
import { defaultDeps } from '../../src/jobs'

useRunnerHome()
const machine = '44444444-4444-4444-8444-444444444444'
const deps = {
  ...defaultDeps(machine),
  akb: () => ({ command: process.execPath, args: [process.env.FAKE_AKB_ENTRY!], version: 'test', shim: path.join(runnerHome(), 'bin/akb/test/shim') }),
  runtimes: async () => [{ name: 'claude-code' as const, installed: true }],
  watchMs: null, renewMs: 50, leaseMs: 2000, endMs: 100, stopMs: 2000, retryMs: 50,
}
if (process.argv[2] === '--reclaim') {
  await reclaimFlowWorkerAfterExit(process.argv[3]!, process.argv[5]!, deps, process.argv[4])
} else if (process.argv[2]) {
  await runFlowWorker(process.argv[2], process.argv[3]!, deps, fileURLToPath(import.meta.url))
} else {
  const runner = startRunner({
    registration: async () => ({ machineId: machine, machineName: 'test', version: 'test', runtimes: [] }),
    kind: 'terminal', deps, flowWorkerEntry: fileURLToPath(import.meta.url), heartbeatMs: 100, pollMs: 50,
    nextLook: () => Date.now() + 3600_000,
  })
  process.on('SIGTERM', () => void runner.close().then(() => process.exit()))
  process.on('message', (message) => {
    if (message === 'update') void runner.update().then(() => process.exit())
  })
  void runner.stopped.then(() => process.exit())
}
