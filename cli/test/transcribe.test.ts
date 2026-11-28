import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { runAgent } from '../src/lib/agent-cli.ts'
import { writeSession } from '../src/lib/cloud/session.ts'
import { restoreMachineHome, run } from './helpers/board.ts'

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0

it('transcribes the first audio stream, keeps its leading silence and retries submission without uploading again', { skip: !hasFfmpeg }, async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'akb-transcribe-test-'))
  const api = 'https://transcription.test'
  const previousHome = process.env.AI4KANBAN_HOME
  const previousFetch = globalThis.fetch
  process.env.AI4KANBAN_HOME = cwd
  process.env.AI4KANBAN_TASK = 'task_1'
  process.env.AI4KANBAN_CLOUD_URL = api
  process.env.AI4KANBAN_SUPABASE_URL = api
  t.after(() => {
    globalThis.fetch = previousFetch
    fs.rmSync(cwd, { recursive: true, force: true })
    delete process.env.AI4KANBAN_TASK
    delete process.env.AI4KANBAN_CLOUD_URL
    delete process.env.AI4KANBAN_SUPABASE_URL
    restoreMachineHome()
    if (previousHome) process.env.AI4KANBAN_HOME = previousHome
  })
  writeSession({ version: 1, supabaseUrl: api, accessToken: 'token', refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000, subject: 'user' })
  const media = spawnSync('ffmpeg', ['-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=16x16:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=16000:duration=0.3',
    '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=16000:duration=0.2',
    '-filter_complex', '[1:a]adelay=300:all=1,asplit[first][single]',
    '-map', '0:v', '-map', '[first]', '-map', '2:a', '-disposition:a:0', '0', '-disposition:a:1', 'default',
    '-c:v', 'mpeg4', '-c:a', 'aac', 'clip.mp4',
    '-map', '[single]', '-c:a', 'pcm_s16le', 'single.wav',
    '-map', '0:v', '-c:v', 'mpeg4', 'silent.mp4',
  ], { cwd, encoding: 'utf8' })
  assert.equal(media.status, 0, media.stderr)

  const submits: { key: string | null; body: unknown }[] = []
  let uploads = 0
  let failJob = false
  const result = { language: 'zh', segments: [{ id: 'seg_1', text: '你好 <World>', start_ms: 300, end_ms: 591 }] }
  globalThis.fetch = async (url, init) => {
    switch (new URL(String(url)).pathname) {
      case '/v1/tasks/task_1/artifacts': return Response.json({ id: 'art_1' }, { status: 201 })
      case '/v1/artifacts/art_1/uploads': return Response.json({ id: 'upl_1' }, { status: 201 })
      case '/v1/uploads/upl_1': {
        uploads++
        assert.ok(init?.body instanceof Blob)
        const wav = Buffer.from(await init.body.arrayBuffer())
        assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
        assert.equal(wav.readUInt16LE(22), 1)
        assert.equal(wav.readUInt32LE(24), 16_000)
        const data = wav.indexOf('data', 12) + 8
        assert.ok(wav.length > 16_000)
        assert.ok(wav.subarray(data, data + 8000).every(byte => byte === 0))
        assert.ok(wav.subarray(data + 12_000).some(byte => byte !== 0))
        return Response.json({ uploaded: true })
      }
      case '/v1/artifacts/art_1/versions': return Response.json({ version: 1 }, { status: 201 })
      case '/v1/transcriptions':
        submits.push({ key: new Headers(init?.headers).get('idempotency-key'), body: JSON.parse(String(init?.body)) })
        if (submits.length === 1) throw new Error('Connection interrupted after submission')
        return Response.json({ id: 'trn_1' }, { status: 201 })
      case '/v1/transcriptions/trn_1':
        return Response.json(failJob ? { id: 'trn_1', status: 'failed', error: { code: 'transcription_failed', message: 'Model failed' } }
          : { id: 'trn_1', status: 'done', result })
      default: throw new Error(`Unexpected request to ${url}`)
    }
  }

  const outputs = ['--out', 'transcript.json', '--vtt', 'captions.vtt']
  const command = ['transcribe', 'clip.mp4', ...outputs]
  await assert.rejects(run(cwd, [...command, '--audio-stream', '1']), /unknown option '--audio-stream'/)
  await assert.rejects(run(cwd, ['transcribe', 'silent.mp4', ...outputs]), /The media contains no audio streams\./)
  assert.equal(uploads, 0)
  assert.equal(await runAgent([...command, '--language', 'zh'], { cwd }), 0)
  assert.equal(uploads, 1)
  assert.equal(submits.length, 2)
  assert.ok(submits[0]?.key)
  assert.deepEqual(submits[0], submits[1])
  assert.deepEqual(submits[0]?.body, { audio: { artifact: 'art_1', version: 1 }, language: 'zh' })
  const transcript = fs.readFileSync(path.join(cwd, 'transcript.json'), 'utf8')
  assert.deepEqual(JSON.parse(transcript), { ...result, source: { media: 'clip.mp4' } })
  const captions = fs.readFileSync(path.join(cwd, 'captions.vtt'), 'utf8')
  assert.match(captions, /00:00:00\.300 --> 00:00:00\.591\n你好 &lt;World&gt;/)
  failJob = true
  await assert.rejects(run(cwd, command), /Model failed/)
  assert.equal(fs.readFileSync(path.join(cwd, 'transcript.json'), 'utf8'), transcript)
  assert.equal(fs.readFileSync(path.join(cwd, 'captions.vtt'), 'utf8'), captions)

  failJob = false
  assert.equal(await runAgent(['transcribe', 'single.wav', ...outputs], { cwd }), 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, 'transcript.json'), 'utf8')),
    { ...result, source: { media: 'single.wav' } })
  assert.equal(fs.readFileSync(path.join(cwd, 'captions.vtt'), 'utf8'), captions)
})
