import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { it } from 'node:test'
import { packOfficial } from '../../official/pack.ts'
import { checkStudioFiles } from '../src/lib/shared/studio-files.ts'

it('ships a self-contained Video Clone storyboard validator, without the removed role entry point', () => {
  const studio = packOfficial(process.env.AI4KANBAN_STUDIOS!).find(s => s.id === 'wf_builtin_video_clone')!
  const checked = checkStudioFiles(studio.files, true)
  assert.ok(checked.ok)
  assert.deepEqual(checked.def.previews.map(p => p.id), ['clone-storyboard', 'video-template'])
  assert.deepEqual(checked.def.previews.map(p => p.title), [
    { en: 'Clone storyboard', zh: '复刻分镜' }, { en: 'Video template', zh: '视频模板' },
  ])
  assert.ok(!Object.keys(studio.files).some(p => p.startsWith('agents/') || p === 'shared/RULES.md'))
  assert.doesNotMatch(studio.files['STUDIO.md']!, /agent-file|video-cloner|video-template-builder/)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-clone-'))
  try {
    for (const name of ['references/storyboard-contract.md', 'references/storyboard.schema.json', 'references/storyboard.example.json', 'scripts/validate-storyboard.mjs', 'shared/music.md']) {
      const file = path.join(root, name)
      assert.ok(studio.files[name], name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, studio.files[name]!)
    }
    const dir = path.join(root, '840')
    fs.mkdirSync(dir)
    const file = path.join(dir, 'clone.json')
    const example = JSON.parse(studio.files['references/storyboard.example.json']!)
    for (const shot of example.shots) shot.frames = []
    example.shots[1].start = 6
    fs.writeFileSync(file, JSON.stringify(example))
    const validate = () => spawnSync(process.execPath, [path.join(root, 'scripts/validate-storyboard.mjs'), file, '--json'], { encoding: 'utf8', cwd: root })
    const invalid = validate()
    assert.equal(invalid.status, 1)
    assert.ok(JSON.parse(invalid.stdout).some((p: { code: string; pointer: string }) => p.code === 'timeline-gap' && p.pointer === '/shots/1/start'))
    example.shots[1].start = example.shots[0].end
    fs.writeFileSync(file, JSON.stringify(example))
    const repaired = validate()
    assert.equal(repaired.status, 0, repaired.stderr || repaired.stdout)
    assert.deepEqual(JSON.parse(repaired.stdout), [])
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
