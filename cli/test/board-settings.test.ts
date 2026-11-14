// The board settings are each person's, under `.akb/` (#1271). A board that still commits
// `docs/kanban/ui.config.json` hands it over on the first read and loses the old file.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'

import { readConfigRaw, writeConfig } from '../src/lib/agent/settings.ts'
import { setBoardRoot, UI_CONFIG } from '../src/lib/paths.ts'
import { forgetMachineState, move } from './helpers/board.ts'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-settings-'))

after(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  fs.rmSync(path.join(root, 'docs'), { recursive: true, force: true })
  forgetMachineState(root)
  setBoardRoot(root)
})

const LEGACY_UI_CONFIG = path.join(root, 'docs/kanban/ui.config.json')
const writeLegacy = (cfg: unknown): void => {
  fs.mkdirSync(path.dirname(LEGACY_UI_CONFIG), { recursive: true })
  fs.writeFileSync(LEGACY_UI_CONFIG, JSON.stringify(cfg))
}

describe('where the board settings live', () => {
  it('sits in the machine state, not the board folder', () => {
    assert.equal(LEGACY_UI_CONFIG, path.join(root, 'docs', 'kanban', 'ui.config.json'))
    assert.ok(UI_CONFIG.includes(`${path.sep}.akb${path.sep}boards${path.sep}`), UI_CONFIG)
  })

  it('ignores and preserves a file in the old location', () => {
    writeLegacy({ proposer: false })
    assert.deepEqual(readConfigRaw(), {})
    assert.equal(writeConfig(cfg => { cfg.autoTriage = false }).ok, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(UI_CONFIG, 'utf8')), { autoTriage: false })
    assert.deepEqual(JSON.parse(fs.readFileSync(LEGACY_UI_CONFIG, 'utf8')), { proposer: false })
  })

  it('writes no committed file on a new board', async () => {
    await move(root, ['init'])
    assert.equal(writeConfig((cfg) => { cfg.proposer = false }).ok, true)
    assert.equal(fs.existsSync(LEGACY_UI_CONFIG), false)
    assert.ok(fs.existsSync(UI_CONFIG))
  })
})
