import fs from 'node:fs'
import path from 'node:path'

import { readCloudAccount, signOutOfCloud } from '../lib/cloud/account'
import { cloudEndpoints } from '../lib/cloud/config'
import { accessToken, CLOUD_ACCESS_HINTS } from '../lib/cloud/session'
import { workspaceTask } from '../lib/cloud/tasks'
import { die } from '../lib/paths'
import { BoardError, say } from '../lib/io'
import { cloudBytes, cloudError, cloudProblem, invalidResponse, readCloudJson, type CloudProblem } from '../lib/cloud/response'
import type { MoveResult } from '../lib/types'

export async function cmdCloud(args: string[], program: string): Promise<MoveResult> {
  const [sub] = args
  if (sub === 'sign-out') {
    signOutOfCloud()
    say('Signed out of WildCrane Cloud on this machine.')
    return { signedOut: true }
  }
  if (sub !== undefined) {
    die(
      `unknown \`account\` command "${sub}". Try \`${program} account\` or \`${program} account sign-out\`.`,
      { kind: 'unknown-move' },
    )
  }

  const account = await readCloudAccount()
  if (account.verificationFailure) {
    if (account.handle || account.email) say(`Cached account: ${account.handle ? '@' + account.handle : account.email}`)
    const failure = account.verificationFailure
    const hint = failure.code === 'expired' || failure.code === 'unauthenticated' ? CLOUD_ACCESS_HINTS.expired
      : failure.code === 'unreachable' ? CLOUD_ACCESS_HINTS.unreachable : 'Cloud verification failed.'
    throw cloudError({ ...failure, message: [hint, failure.message].filter(Boolean).join(' ') },
      { details: { cached: true, cloud: account } })
  }
  for (const line of report(account, program)) say(line)
  return { cloud: account }
}

function report(account: Awaited<ReturnType<typeof readCloudAccount>>, program: string): string[] {
  const who = account.handle
    ? `@${account.handle}${account.name ? ` (${account.name})` : ''}`
    : 'this account'
  const lines: string[] = []
  switch (account.state) {
    case 'signed-out':
      lines.push(account.configured ? CLOUD_ACCESS_HINTS['signed-out'] : account.message ?? 'Not signed in to WildCrane Cloud.')
      break
    case 'signed-in':
      lines.push(`Signed in to Cloud as ${who}.`)
      lines.push(`Held at ${account.sessionFile}, for this whole machine.`)
      lines.push(`Sign out with \`${program} account sign-out\`.`)
      break
    case 'not-admitted':
      lines.push(`Signed in as ${who}, and not admitted.`)
      if (account.message) lines.push(account.message)
      // Asking is a button in the app (#327). A terminal has none, so it says where it is.
      lines.push(
        account.inviteRequestedAt
          ? `You asked for an invite on ${account.inviteRequestedAt.slice(0, 10)}. We answer by email.`
          : 'Request an invite in the WildCrane app, under Configuration → Cloud.',
      )
      lines.push(`Sign out with \`${program} account sign-out\`.`)
      break
    case 'expired':
      lines.push(`Your Cloud sign-in as ${who} has expired.`)
      lines.push('Sign in again from the WildCrane app, under Configuration → Cloud.')
      break
  }
  if (account.error) lines.push(`Cloud could not be reached: ${account.error}`)
  return lines.filter(Boolean)
}

// ---- generation ---------------------------------------------------------------------

interface Generation {
  usage: string
  endpoint: string
  body: Record<string, unknown>
  out: string
  proRequired: string
  failed: string
  fallback: string
  /** What the success line names in brackets after the file. */
  label: (res: Response) => string
  /** Where the answer goes when its format is not the one `out` names. */
  outFor?: (res: Response, out: string) => string
}

const REF_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

function usage(problem: string, line: string): never {
  die(`${problem}\nusage: ${line}`, { kind: 'bad-args', bare: true, exitCode: 2 })
}

const TIERS = ['economy', 'standard', 'premium']
const SPEECH_TIERS = ['standard', 'premium']

/** `akb image --aspect <ratio> [--tier <tier>] [--ref <file>]… --out <file.png> "<prompt>"` */
export async function cloudImage(
  opts: { aspect?: string; tier?: string; refs: string[]; out?: string; prompt: string },
  program: string,
): Promise<MoveResult> {
  const line = `${program} image --aspect <ratio> [--tier economy|standard|premium] [--ref <file>]… --out <file.png> "<prompt>"`
  if (!opts.aspect) usage('Missing --aspect.', line)
  const tier = opts.tier ?? 'standard'
  if (!TIERS.includes(tier)) usage(`--tier ${tier}: pick one of ${TIERS.join(', ')}.`, line)
  if (!opts.out) usage('Missing --out.', line)
  const prompt = opts.prompt.trim()
  if (!prompt) usage('Missing the prompt.', line)
  const references = opts.refs.map((file) => {
    const type = REF_TYPES[path.extname(file).toLowerCase()]
    if (!type) usage(`--ref ${file}: use a PNG, JPEG or WebP file.`, line)
    try {
      return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`
    } catch (e) {
      usage(`--ref ${file}: ${e instanceof Error ? e.message : String(e)}`, line)
    }
  })
  return generate({
    usage: line,
    endpoint: '/v1/image',
    body: { prompt, aspect: opts.aspect, tier, references },
    out: opts.out,
    proRequired: 'Image generation requires Pro.',
    failed: 'Could not generate the image.',
    fallback: 'Use an existing image or screenshot.',
    // A Cloud without tiers answers no `x-tier`, and generated at standard.
    label: (res) => `${res.headers.get('x-tier') ?? 'standard'}`,
  })
}

/** `akb tts --voice <name> [--tier <tier>] --out <file.wav> "<text>"` — never falls back to
 *  another voice or tier. */
export async function cloudTts(
  opts: { voice?: string; tier?: string; out?: string; text: string },
  program: string,
): Promise<MoveResult> {
  const line = `${program} tts --voice <name> [--tier standard|premium] --out <file.wav> "<text>"`
  if (!opts.voice) usage('Missing --voice.', line)
  const tier = opts.tier ?? 'standard'
  if (!SPEECH_TIERS.includes(tier)) usage(`--tier ${tier}: pick one of ${SPEECH_TIERS.join(', ')}.`, line)
  if (!opts.out) usage('Missing --out.', line)
  const text = opts.text.trim()
  if (!text) usage('Missing the text to speak.', line)
  const voice = opts.voice
  return generate({
    usage: line,
    endpoint: '/v1/speech',
    body: { voice, text, tier },
    out: opts.out,
    proRequired: 'Hosted voices require Pro.',
    failed: 'Could not generate narration.',
    fallback: 'Run `npx hyperframes tts --list` to find a local voice.',
    label: (res) => `${res.headers.get('x-voice') ?? voice}, ${res.headers.get('x-tier') ?? 'standard'}`,
    // Chinese voices answer mp3 (#87).
    outFor: (res, out) =>
      res.headers.get('content-type') === 'audio/mpeg' && /\.wav$/i.test(out) ? out.replace(/\.wav$/i, '.mp3') : out,
  })
}

/** `akb music --seconds <n> --out <file.mp3> "<prompt>"` */
export async function cloudMusic(
  opts: { seconds?: string; out?: string; prompt: string },
  program: string,
): Promise<MoveResult> {
  const line = `${program} music --seconds <n> --out <file.mp3> "<prompt>"`
  if (!opts.seconds) usage('Missing --seconds.', line)
  if (!opts.out) usage('Missing --out.', line)
  const seconds = Number(opts.seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) usage(`--seconds ${opts.seconds}: give a number of seconds.`, line)
  const prompt = opts.prompt.trim()
  if (!prompt) usage('Missing the prompt.', line)
  return generate({
    usage: line,
    endpoint: '/v1/music',
    body: { prompt, seconds },
    out: opts.out,
    proRequired: 'Music generation requires Pro.',
    failed: 'Could not generate music.',
    fallback: 'Use your own audio track.',
    label: () => `${seconds}s`,
  })
}

function refuse(problem: CloudProblem, message: string, exitCode = 1): never {
  throw cloudError({ ...problem, message }, { bare: true, exitCode })
}

async function generate(g: Generation): Promise<MoveResult> {
  const token = await accessToken()
  if (!token.ok) throw cloudError({
    code: token.reason.replace('-', '_'), retryable: token.reason === 'unreachable',
    message: [CLOUD_ACCESS_HINTS[token.reason], 'error' in token ? token.error : undefined].filter(Boolean).join('\n'),
  }, { bare: true, exitCode: 1 })
  const task = workspaceTask()
  let res: Response
  try {
    res = await fetch(`${cloudEndpoints().api}${g.endpoint}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json', ...(task ? { 'x-wildcrane-task': task } : {}) },
      body: JSON.stringify(g.body),
    })
  } catch {
    throw cloudError({ code: 'unreachable', message: CLOUD_ACCESS_HINTS.unreachable, retryable: true }, { bare: true, exitCode: 1 })
  }
  const contentType = res.headers.get('content-type') ?? ''
  const problem = !res.ok || /^application\/(?:[\w.+-]+\+)?json(?:;|$)/i.test(contentType)
    ? cloudProblem(res, await readCloudJson(res)) ?? invalidResponse('a complete media file')
    : null
  if (problem) {
    if (res.status === 401) refuse(problem, `${CLOUD_ACCESS_HINTS.expired}\n${problem.message}`)
    if (problem.code === 'pro_required') refuse(problem, g.proRequired)
    if (problem.code === 'api_balance_insufficient' || problem.code === 'pricing_changed') refuse(problem, problem.message)
    if (problem.code === 'credits_used_up') {
      refuse(problem, res.headers.has('retry-after')
        ? 'AI credits are used up. See Settings → Usage or wait for the next reset.'
        : 'Trial AI credits are used up. Add API balance in Settings → Usage.')
    }
    if (res.status === 400) refuse(problem, `${problem.message}\nusage: ${g.usage}`, 2)
    const generic = problem.message === `Cloud answered ${res.status}.`
      || /^The (image|narration|music) could not be generated\. Try again shortly\.$/.test(problem.message)
    const reason = generic ? g.failed : problem.message
    refuse(problem, `${reason}\n${g.fallback}`)
  }
  let bytes: Buffer
  try {
    bytes = await cloudBytes(res, 'a complete media file')
    if (!mediaMatches(contentType, bytes, g.endpoint.endsWith('image'))) throw cloudError(invalidResponse('a complete media file'))
  } catch (error) {
    if (!(error instanceof BoardError)) throw error
    throw cloudError({ code: error.kind, message: `${error.message}\n${g.fallback}`, retryable: true }, { bare: true, exitCode: 1 })
  }
  const out = g.outFor?.(res, g.out) ?? g.out
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, bytes)
  const charge = res.headers.get('x-wildcrane-api-charge-usd')
  say(`${out} (${g.label(res)}${charge ? `, WildCrane API $${charge}` : ''})`)
  return { out }
}

function mediaMatches(contentType: string, bytes: Buffer, image: boolean): boolean {
  const type = contentType.toLowerCase().split(';', 1)[0]?.trim()
  const starts = (signature: string, offset = 0) => bytes.toString('ascii', offset, offset + signature.length) === signature
  const riff = (format: string) => starts('RIFF') && starts(format, 8)
  if (image) {
    if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    if (type === 'image/webp') return riff('WEBP')
    return false
  }
  if (type === 'audio/wav') return riff('WAVE')
  return type === 'audio/mpeg' && (starts('ID3') || bytes.length > 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
}
