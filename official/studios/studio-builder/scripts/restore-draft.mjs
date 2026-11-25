import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const [input, folder] = process.argv.slice(2)
if (!input || !folder) throw Error('Usage: node restore-draft.mjs <approved review.json> <draft folder>')
const review = JSON.parse(fs.readFileSync(input, 'utf8'))
const fileLimit = 2 * 1024 * 1024
const studioLimit = 10 * 1024 * 1024
if (review.version !== 2 || !Array.isArray(review.files)) throw Error('Expected an approved Studio file snapshot.')
const safePath = name => typeof name === 'string' && !/[<>:"\\|?*\x00-\x1f\x7f]/.test(name)
  && name.split('/').every(part => part && Buffer.byteLength(part) <= 255 && !/[. ]$/.test(part) && !/^(?:\.git$|(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))/i.test(part))
const files = new Map()
const bodies = new Map()
let total = 0
for (const { path: name, after } of review.files) {
  if (after === null) continue
  if (!safePath(name) || Buffer.byteLength(name) > 512 || ['version.json', '.publication.json'].includes(name.toLowerCase()) || files.has(name)) {
    throw Error('Invalid Studio file path: ' + name)
  }
  if (files.size === 500) throw Error('A Studio holds at most 500 files.')
  if (typeof after !== 'string' || /[:\\\x00-\x1f]/.test(after) || after.split('/').some(part => !part || part === '.' || part === '..')) {
    throw Error('Missing pinned source: ' + name)
  }
  const dir = fs.realpathSync(path.dirname(input))
  const source = fs.realpathSync(path.join(dir, after))
  if (!source.startsWith(dir + path.sep)) throw Error('Invalid Studio source: ' + name)
  const stat = fs.statSync(source)
  if (!stat.isFile()) throw Error('Invalid Studio source: ' + name)
  const screenshot = /^screenshots\/[\w.-]+\.(png|jpe?g|webp)$/.exec(name)
  const prefix = screenshot ? 'data:image/' + (screenshot[1] === 'jpg' ? 'jpeg' : screenshot[1]) + ';base64,' : ''
  if (stat.size > (screenshot ? Math.ceil(fileLimit / 3) * 4 + prefix.length : fileLimit)) throw Error(name + ' is larger than 2 MiB.')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(source))
  const encoded = prefix && text.startsWith(prefix) ? text.slice(prefix.length) : null
  const decoded = encoded === null ? null : Buffer.from(encoded, 'base64')
  const body = decoded && decoded.toString('base64') === encoded ? decoded : Buffer.from(text)
  if (body.length > fileLimit) throw Error(name + ' is larger than 2 MiB.')
  total += body.length
  if (total > studioLimit) throw Error('Studio files are larger than 10 MiB together.')
  files.set(name, text)
  bodies.set(name, body)
}
if (review.base) {
  const { id, version } = review.base
  const versionFile = review.versionFile ?? JSON.stringify({ id, version }) + '\n'
  const saved = JSON.parse(versionFile)
  if (saved.id !== id || saved.version !== version) throw Error('The version file disagrees with the approved baseline.')
  files.set('version.json', versionFile)
  bodies.set('version.json', Buffer.from(versionFile))
}
const fingerprint = createHash('sha256').update(JSON.stringify([...files].sort(([a], [b]) => a < b ? -1 : 1))).digest('hex')
if (!files.has('STUDIO.md') || fingerprint !== review.fingerprint) throw Error('The restored draft does not match the approved fingerprint.')
const target = path.resolve(folder)
const current = fs.lstatSync(target, { throwIfNoEntry: false })
if (current && (!current.isDirectory() || fs.readdirSync(target).length)) throw Error('Use a missing or empty draft folder.')
fs.mkdirSync(path.dirname(target), { recursive: true })
const staging = fs.mkdtempSync(path.join(path.dirname(target), '.studio-draft-'))
try {
  for (const [name, body] of bodies) {
    const file = path.join(staging, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body)
  }
  if (current) fs.rmdirSync(target)
  fs.renameSync(staging, target)
} finally {
  fs.rmSync(staging, { recursive: true, force: true })
}
console.log(fingerprint)
