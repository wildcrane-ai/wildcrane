// Verify the release workflow's npm identity without publishing or retaining credentials.
import assert from 'node:assert/strict'
import fs from 'node:fs'

const url = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
url.searchParams.set('audience', 'npm:registry.npmjs.org')
const identity = await fetch(url, {
  headers: { authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  signal: AbortSignal.timeout(30_000),
})
assert.ok(identity.ok, `GitHub identity request failed: HTTP ${identity.status}`)
const { value } = await identity.json()
if (typeof value !== 'string') throw new Error('GitHub did not return an OIDC identity')
const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString())
assert.equal(claims.repository, 'wildcrane-ai/wildcrane')
assert.ok(claims.workflow_ref.startsWith('wildcrane-ai/wildcrane/.github/workflows/plugin-release.yml@'))
const response = await fetch('https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/wildcrane-opencode', {
  method: 'POST',
  headers: { authorization: `Bearer ${value}` },
  signal: AbortSignal.timeout(30_000),
})
assert.ok(response.ok, `npm rejected the release identity: HTTP ${response.status}`)
const exchange = await response.json()
if (typeof exchange.token !== 'string' || !exchange.token) throw new Error('npm did not issue a package-scoped credential')
const result = { package: 'wildcrane-opencode', workflow: claims.workflow_ref, ref: claims.ref,
  exchangeStatus: response.status, published: false }
console.log(JSON.stringify(result))
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Verified npm trusted publisher without publishing:\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`)
