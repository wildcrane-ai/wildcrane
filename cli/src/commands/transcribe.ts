import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { call, workspaceTask, type CloudCall } from '../lib/cloud/tasks'
import { requireResponse } from '../lib/cloud/response'
import { BoardError } from '../lib/io'
import { MAX_TRANSCRIPTION_BYTES, transcriptionLanguage, type Transcript, type TranscriptionJob } from '../lib/shared/transcription'

const exec = promisify(execFile)
const pcmType = 'audio/wav'

interface Options {
  language?: string
  out: string
  vtt: string
}

const fail = (message: string, code?: string) => new BoardError(message, { code, kind: code })

async function extractAudio(input: string, wav: string): Promise<void> {
  try {
    await exec('ffmpeg', ['-nostdin', '-v', 'error', '-i', input, '-map', '0:a:0', '-ac', '1', '-ar', '16000',
      '-c:a', 'pcm_s16le', '-fs', String(MAX_TRANSCRIPTION_BYTES + 1), '-f', 'wav', wav])
  } catch (error) {
    const cause = error as { code?: string; stderr?: string }
    if (cause.code === 'ENOENT') throw fail('Install ffmpeg and make it available on PATH.')
    const stderr = cause.stderr?.trim() ?? ''
    if (/Stream map '(?:0:a:0)?' matches no streams\b/.test(stderr)) throw fail('The media contains no audio streams.')
    throw fail(stderr || 'ffmpeg could not read the media.')
  }
}

async function cloud<T>(send: () => Promise<CloudCall<T>>, retries = 0): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const answer = await send()
    if (answer.ok) return answer.value
    if (!answer.retryable || attempt >= retries) throw fail(answer.error, answer.code)
    await delay(answer.code === 'idempotency_in_progress' ? 5_000 : 1_000 * (attempt + 1))
  }
}

async function uploadAudio(task: string, name: string, wav: Blob, key: string) {
  const artifact = requireResponse(await cloud(() => call<{ id: string }>('POST',
    `/v1/tasks/${encodeURIComponent(task)}/artifacts`, { type: 'asset', name }, `transcribe-artifact-${key}`), 3),
  'an audio artifact id', value => /^art_[0-9a-z_]+$/.test(value.id))
  const routes = `/v1/artifacts/${artifact.id}`
  const upload = requireResponse(await cloud(() => call<{ id: string }>('POST', `${routes}/uploads`,
    { content_type: pcmType, size: wav.size })),
  'an audio upload id', value => /^upl_[0-9a-z_]+$/.test(value.id))
  await cloud(() => call('PUT', `/v1/uploads/${upload.id}`, wav))
  const version = requireResponse(await cloud(() => call<{ version: number }>('POST', `${routes}/versions`,
    { upload: upload.id }, `transcribe-version-${key}`), 3),
  'an audio artifact version', value => Number.isSafeInteger(value.version) && value.version > 0)
  return { artifact: artifact.id, version: version.version }
}

async function poll(id: string): Promise<Transcript> {
  const deadline = Date.now() + 15 * 60_000
  do {
    const pending = await cloud(() => call<TranscriptionJob>('GET', `/v1/transcriptions/${id}`, undefined, undefined,
      { allowResultError: true }), 3)
    if (pending.status === 'done' && pending.result && Array.isArray(pending.result.segments)) return pending.result
    if (pending.status === 'failed') throw fail(pending.error?.message || 'The audio could not be transcribed.', 'transcription_failed')
    if (pending.status !== 'running' && pending.status !== 'queued') throw fail('Cloud did not return a valid transcription job.')
    await delay(1_000)
  } while (Date.now() < deadline)
  throw fail(`Transcription ${id} did not finish in time.`)
}

function timestamp(ms: number): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

function webvtt(transcript: Transcript): string {
  return 'WEBVTT\n\n' + transcript.segments.map(({ id, text, start_ms, end_ms }) =>
    `${id}\n${timestamp(start_ms)} --> ${timestamp(end_ms)}\n${text.replace(/\s*\r?\n\s*/g, ' ')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n\n`).join('')
}

async function outputPath(cwd: string, file: string): Promise<string> {
  const absolute = path.resolve(cwd, file)
  await mkdir(path.dirname(absolute), { recursive: true })
  return path.join(await realpath(path.dirname(absolute)), path.basename(absolute))
}

export async function cmdTranscribe(media: string, options: Options, cwd: string) {
  const task = workspaceTask()
  if (!task) throw fail('Run akb transcribe inside a WildCrane Runner task.')
  const language = options.language ?? 'auto'
  if (!transcriptionLanguage(language)) throw fail('Use auto or a supported language code.')

  try {
    const input = await realpath(path.resolve(cwd, media))
    if (!(await stat(input)).isFile()) throw fail('Choose a local media file.')
    const [out, vtt] = await Promise.all([outputPath(cwd, options.out), outputPath(cwd, options.vtt)])
    if (out === vtt || out === input || vtt === input) throw fail('Use distinct paths for the media, JSON and WebVTT files.')
    for (const target of [out, vtt]) {
      if ((await stat(target).catch(error => {
        if (error.code !== 'ENOENT') throw error
      }))?.isDirectory()) throw fail(`The output path is a directory: ${target}`)
    }

    const scratch = await mkdtemp(path.join(tmpdir(), 'akb-transcribe-'))
    const key = randomUUID()
    const outTemp = `${out}.${key}.tmp`
    const vttTemp = `${vtt}.${key}.tmp`
    try {
      const wav = path.join(scratch, 'audio.wav')
      await extractAudio(input, wav)
      const { size } = await stat(wav)
      if (size > MAX_TRANSCRIPTION_BYTES) throw fail(`The extracted WAV exceeds ${MAX_TRANSCRIPTION_BYTES / 1048576} MiB.`)

      const audio = await uploadAudio(task, `Transcription ${key}.wav`, new Blob([await readFile(wav)], { type: pcmType }), key)
      const { id } = requireResponse(await cloud(() => call<{ id: string }>('POST', '/v1/transcriptions',
        { audio, language }, `transcribe-${key}`), 3),
      'a transcription job id', value => /^trn_[0-9a-z_]+$/.test(value.id))
      const transcript = await poll(id)
      const file = { language: transcript.language, segments: transcript.segments, source: { media } }
      await writeFile(outTemp, JSON.stringify(file, null, 2) + '\n')
      await writeFile(vttTemp, webvtt(transcript))
      await rename(outTemp, out)
      await rename(vttTemp, vtt)
      return { id, out, vtt }
    } finally {
      await Promise.allSettled([rm(scratch, { recursive: true, force: true }), rm(outTemp, { force: true }), rm(vttTemp, { force: true })])
    }
  } catch (error) {
    if (error instanceof BoardError) throw error
    throw fail(error instanceof Error ? error.message : String(error))
  }
}
