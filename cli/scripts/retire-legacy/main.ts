import path from 'node:path'
import { parseArgs } from 'node:util'
import { Conversion, rollback } from './convert.ts'
const { values } = parseArgs({ options: {
  project: { type: 'string' }, board: { type: 'string' }, 'legacy-state': { type: 'string' },
  'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, receipt: { type: 'string' }, rollback: { type: 'string' },
} })
try {
  if (values.rollback) console.log(JSON.stringify(rollback(path.resolve(values.rollback))))
  else {
    if (!values.project || !values.board || (values.apply && !values.receipt)) throw Error('use --project <root> --board <board> [--dry-run | --apply --receipt <file>]')
    const plan = new Conversion(values.project, values.board, values['legacy-state'])
    const report = plan.plan()
    console.log(JSON.stringify(report, null, 2))
    if (report.conflicts.length) process.exitCode = 1
    else if (values.apply) { const result = plan.apply(path.resolve(values.receipt!)); console.log(JSON.stringify({ status: result.status, receipt: path.resolve(values.receipt!) })) }
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1 }
