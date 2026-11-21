// What a card finishing in planning has to carry before it is archived (#1057, #1117, #1126, #1692): a
// finished video, template render, deck or article, or a carousel's pages as a `<Storyboard>` of `pages-*.json`.

import { cmdRemove } from '../src/commands/remove.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

import { ASSETS, setBoardRoot } from '../src/lib/paths.ts'
import { planDeliveryGap } from '../src/lib/view/rules.ts'
import { move } from './helpers/board.ts'

const done = (body: string) => planDeliveryGap({ questions: [], todos: { total: 1, done: 1 }, body: `${body}\n\n- [x] Render: \`node render.mjs\`` })

describe('the deliverable a card finishing in planning carries', () => {
  it('counts a carousel pages storyboard', () => {
    assert.equal(done('<Storyboard src=".assets/1/pages-3x4.json" label="3:4" />'), null)
  })

  it('counts a blog article', () => {
    assert.equal(done('<Asset src=".assets/1/launch.md" label="Launch" />'), null)
    assert.equal(done('<Asset src=".assets/1/launch.mdx" label="Launch" />'), null)
  })

  it('still refuses a video with only its cover, and a deck with only its storyboard', () => {
    assert.equal(done('<Asset src=".assets/1/cover.png" />'), 'deliverable')
    assert.equal(done('<Storyboard src=".assets/1/storyboard.json" />'), 'deliverable')
  })
})

describe('explicit archival after agent checks (#735)', () => {
  it('does not gate archival on Todos, output records or missing files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-agent-archive-'))
    try {
      fs.mkdirSync(path.join(root, 'docs/kanban/todo'), { recursive: true })
      setBoardRoot(root)
      for (const [index, studio] of ['carousel-post', 'blog-post', 'video-clone'].entries()) {
        const id = index + 1
        await move(root, ['create', '--id', String(id), '--title', 'Explicit completion', '--studio', studio])
        cmdRemove(id, 'completed')
        assert.equal(fs.existsSync(path.join(root, `docs/kanban/.archive/${id}-explicit-completion.md`)), true)
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
