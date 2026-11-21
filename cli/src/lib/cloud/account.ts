// Which account this machine acts as, and whether Cloud takes its work.
//
// One call, four answers — the four a sign-in can come back with, which is exactly what the
// Cloud section of the Configuration dialog draws and what `akb account` prints. Admission is
// never decided here: the service is asked every time, and its refusal is carried through
// word for word so a client shows it as it stands.

import { heldAvatar } from './avatar'
import { cloudConfigured, cloudEndpoints, NOT_CONFIGURED } from './config'
import { forgetPro } from './pro'
import { accessToken, clearSession, readSession, sessionFile } from './session'
import type { CloudAccount } from './types'
import { cloudProblem, invalidResponse, isRecord, readCloudJson, type CloudProblem } from './response'

export type { CloudAccount, CloudMove, CloudState } from './types'

interface SessionBody {
  session?: {
    admitted?: boolean
    handle?: string | null
    name?: string | null
    avatar_url?: string | null
    avatarUrl?: string | null
    email?: string
    accountId?: string | null
    inviteRequestedAt?: string | null
  }
  refusal?: { code?: string; message?: string }
}

/** Ask Cloud who this machine is. */
export async function readCloudAccount(): Promise<CloudAccount & { verificationFailure?: CloudProblem }> {
  const blank: CloudAccount = {
    state: 'signed-out',
    handle: null,
    name: null,
    avatarUrl: null,
    avatarData: null,
    email: null,
    message: null,
    inviteRequestedAt: null,
    sessionFile: sessionFile(),
    configured: cloudConfigured(),
  }
  if (!blank.configured) return { ...blank, message: NOT_CONFIGURED }

  const unverified = (problem: CloudProblem, state: CloudAccount['state'] = 'signed-in'): CloudAccount & { verificationFailure: CloudProblem } =>
    ({ ...blank, ...held(), state, ...(state === 'signed-in' ? { error: problem.message } : { message: problem.message }),
      verificationFailure: problem })
  const token = await accessToken()
  if (!token.ok) {
    if (token.reason === 'signed-out') return blank
    // Still signed in, just unable to prove it this minute.
    if (token.reason === 'unreachable') {
      return unverified({ code: 'unreachable', message: token.error, retryable: true })
    }
    // Auth refused the refresh token, so the sign-in is over. `error` means Cloud could not
    // be reached and both screens say exactly that, so Auth's own words do not go in it.
    return unverified({ code: 'expired', message: token.error ?? 'Your Cloud sign-in has expired. Sign in again.', retryable: false }, 'expired')
  }

  let response: Response
  try {
    response = await fetch(`${cloudEndpoints().api}/v1/session`, {
      headers: { authorization: `Bearer ${token.token}` },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    return unverified({ code: 'unreachable', message: e instanceof Error ? e.message : String(e), retryable: true })
  }
  const value = await readCloudJson(response)
  const problem = cloudProblem(response, value)
  if (problem) {
    if (problem.code === 'unauthenticated') return unverified(problem, 'expired')
    if (problem.code === 'not_admitted') return unverified(problem, 'not-admitted')
    return unverified(problem)
  }
  if (!isRecord(value) || !isRecord(value.session) || typeof value.session.admitted !== 'boolean') {
    return unverified(invalidResponse('an account verification receipt'))
  }
  const body = value as SessionBody
  const session = body.session!
  const avatarUrl = session.avatar_url ?? session.avatarUrl ?? null
  const attested = {
    handle: session.handle ?? null,
    name: session.name ?? null,
    avatarUrl,
    // Costs a fetch the first time this address is seen and a file read every time after,
    // so the picture is on the machine before any screen asks to draw it.
    avatarData: await heldAvatar(avatarUrl),
    email: session.email ?? null,
    inviteRequestedAt: session.inviteRequestedAt ?? null,
  }
  return session.admitted
    ? { ...blank, ...attested, state: 'signed-in' }
    : { ...blank, ...attested, state: 'not-admitted', message: body.refusal?.message ?? null }
}

// --- the one way out of the not-admitted state (#327, #350) -------------------
// Open to a verified sign-in we have not admitted, and one call. It decides nothing: the
// service answers, and its refusal is carried through word for word.


/** Sign this machine out. Nothing already on any board is touched. */
export function signOutOfCloud(): { ok: true } {
  clearSession()
  forgetPro()
  return { ok: true }
}

/** What this machine last knew about the account, for the answers the service can't give.
 *  Never fetches: these are the answers a machine off the network reaches. */
function held(): Pick<CloudAccount, 'handle' | 'name' | 'avatarUrl' | 'avatarData' | 'email'> {
  const session = readSession()
  return {
    handle: session?.handle ?? null,
    name: session?.name ?? null,
    avatarUrl: session?.avatarUrl ?? null,
    avatarData: session?.avatar?.data ?? null,
    email: session?.email ?? null,
  }
}
