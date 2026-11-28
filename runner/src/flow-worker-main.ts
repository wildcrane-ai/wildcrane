import './startup'
import { useRunnerHome } from './home'
import { reclaimFlowWorkerAfterExit, runFlowWorker } from './flow-worker'
import { captureRunnerOutput } from './runner-log'

useRunnerHome()
if (process.argv[2] === '--reclaim') {
  captureRunnerOutput('worker', { job: process.argv[3] })
  await reclaimFlowWorkerAfterExit(process.argv[3] ?? '', process.argv[5] ?? '', undefined, process.argv[4])
} else {
  await runFlowWorker(process.argv[2] ?? '', process.argv[3] ?? '')
}
