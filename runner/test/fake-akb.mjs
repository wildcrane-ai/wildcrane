// A stand-in for the akb the Runner carries: the moves a flow job makes, on a plain folder.
// `FAKE_AKB` (JSON) says how each card verb goes; every call is logged to `FAKE_AKB_LOG`.
// A verb with `hang` leaves its run running and follows it until stopped; `chain` more runs
// start, one per stop, as a delivery's next stage would. A card with a running run refuses a
// verb, as akb's own `cardBusy` does; a test lays one down in `.fake/runs.json`.

import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_AKB_LOG, `${JSON.stringify(argv)}\n`)
const cut = argv.indexOf('--')
// `raw <group> …` (#551) dispatches below by the group, as `memory review|prune` by its old name.
const local = argv[0] === 'raw' && !['init', 'create'].includes(argv[1])
  ? argv[1] === 'memory' ? [`${argv[2] === 'review' ? 'review' : 'prune'}-memory`, ...argv.slice(3)] : argv.slice(1)
  : argv
let words = cut < 0 ? local : local.slice(0, local.indexOf('--'))
if (words[0] === 'previews' && words[1] && !words[1].startsWith('--')) words = ['card', 'preview', words[2], ...words.slice(3)]
const text = cut < 0 ? '' : argv.slice(cut + 1).join(' ')
const flag = (name) => (words.includes(name) ? words[words.indexOf(name) + 1] : undefined)
const board = flag('--board')
const plan = JSON.parse(process.env.FAKE_AKB || '{}')
const state = path.join(board, '.fake')
fs.mkdirSync(state, { recursive: true })
const read = (name, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(state, name), 'utf8'))
  } catch {
    return fallback
  }
}
const write = (name, value) => {
  const file = path.join(state, name)
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value))
  fs.renameSync(temporary, file)
}
const cardOf = (id) => {
  for (const dir of ['todo', '.archive']) {
    const hit = fs.readdirSync(path.join(board, dir), { withFileTypes: true }).find((e) => e.name.startsWith(`${id}-`))
    if (hit) return path.join(board, dir, hit.name, hit.isDirectory() ? 'root.md' : '')
  }
  return null
}
const fail = (message) => {
  console.error(`akb: ${message}`)
  process.exit(1)
}

const [a, b, c] = words
const capturedFiles = directory => Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true, recursive: true })
  .filter(file => file.isFile()).map(file => {
    const target = path.join(file.parentPath, file.name)
    return [path.relative(directory, target), fs.readFileSync(target, 'utf8')]
  }))
const savedPreviews = process.env.AI4KANBAN_SAVED_PREVIEW_FILE
if (savedPreviews) {
  const directory = path.dirname(savedPreviews)
  write('saved-previews.json', {
    directory,
    files: capturedFiles(directory),
  })
}
if (a === 'raw' && b === 'init') {
  fs.mkdirSync(path.join(board, 'todo'), { recursive: true })
  fs.mkdirSync(path.join(board, '.archive'), { recursive: true })
  fs.writeFileSync(path.join(board, 'config.md'), '')
} else if (a === 'raw' && b === 'create') {
  fs.writeFileSync(path.join(state, 'task-env'), process.env.AI4KANBAN_TASK ?? '')
  if (!flag('--id')) fail("a card's number comes from Cloud")
  const id = Number(flag('--id'))
  if (cardOf(id)) {
    console.log(JSON.stringify({ ok: false, error: { kind: 'id-taken', message: `#${id} is already a card here` } }))
    process.exit(1)
  }
  const body = flag('--body-file') ? fs.readFileSync(flag('--body-file'), 'utf8') : ''
  const studio = flag('--studio') ? `studio: ${flag('--studio')}\n` : ''
  fs.writeFileSync(path.join(board, 'todo', `${id}-${(flag('--slug') ?? flag('--title')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task'}.md`), `---\ntitle: ${flag('--title')}\n${studio}questions: []\n---\n\n${body}`)
  console.log(JSON.stringify({ ok: true, id }))
} else if (a === 'card') {
  const how = plan[b] ?? {}
  if (how.refuse) fail(how.refuse)
  const id = Number(c)
  const file = cardOf(id)
  if (!file) fail(`no task with id ${id}`)
  if (process.env.AI4KANBAN_EXECUTION_RUNTIMES) {
    write(`runtime-${id}.json`, JSON.parse(process.env.AI4KANBAN_EXECUTION_RUNTIMES).default)
  }
  const runs = read('runs.json', [])
  if (runs.some((r) => r.cardId === id && r.status === 'running')) fail(`#${id} is already being worked on`)
  if (how.missingFork && words.includes('--fork')) {
    const sessionId = `run-${b}-${runs.length + 1}`
    const reason = `no rollout found for thread id ${flag('--session')}`
    runs.push({ sessionId, cardId: id, action: b, status: 'error', failure: { code: 'codex_fork_source_missing', level: 3, source: 'harness', reason } })
    write('runs.json', runs)
    console.log(JSON.stringify({ ok: false, error: { kind: 'run-failed', message: reason, lastSessionId: sessionId } }))
    process.exit(1)
  }
  // The board every `akb` the agent types reaches.
  fs.writeFileSync(path.join(state, 'agent-board'), process.env.AI4KANBAN_BOARD ?? '')
  fs.writeFileSync(path.join(state, 'session-cost'), process.env.AI4KANBAN_SESSION_COST ?? '')
  if (process.env.AI4KANBAN_TASK_REVIEW) {
    write('review-context.json', {
      review: JSON.parse(process.env.AI4KANBAN_TASK_REVIEW),
      assigned: JSON.parse(process.env.AI4KANBAN_REVIEW_STAGES ?? 'null'),
    })
  }
  // The discussion a Cloud task carries (#2146), gone once the job ends.
  if (flag('--transcript')) fs.writeFileSync(path.join(state, 'transcript'), fs.readFileSync(flag('--transcript'), 'utf8'))
  const sessionId = `run-${b}-${runs.length + 1}`
  console.log(`working on #${id}${text ? `: ${text}` : ''}`)
  if (words.includes('--events')) console.log(JSON.stringify({ kind: 'message', data: { text: `Read #${id}.` } }))
  // What the agent writes on the board besides the card.
  for (const [at, content] of Object.entries(how.writes ?? {})) {
    fs.mkdirSync(path.dirname(path.join(board, at)), { recursive: true })
    fs.writeFileSync(path.join(board, at), content)
  }
  let card = fs.readFileSync(file, 'utf8')
  if (b === 'resolve' && !how.question && !how.failed && !how.reject) {
    card = card.replace(/^questions:\s*\n(?:[ \t]+.*\n)*/m, 'questions: []\n')
  }
  if (how.status) card = card.replace('questions:', `status: ${how.status}\nquestions:`)
  if (how.question) card = card.replace('questions: []', `questions:\n  - Which tone?\n  - question: "${how.question}"\n    mode: single\n    options:\n      - Monthly\n      - Yearly\n    recommend: [1]`)
  fs.writeFileSync(file, `${card}\n${b} ${text}`.trimEnd() + '\n')
  // A follow-up proposed as `akb triage add` writes it.
  if (how.propose) {
    fs.mkdirSync(path.join(board, 'triage'), { recursive: true })
    fs.writeFileSync(path.join(board, 'triage', 'proposed.md'), `---\nsource_id: derived-1\ntitle: ${how.propose}\n${how.studio === '' ? '' : `studio: ${how.studio ?? 'coding'}\n`}collected_at: 2026-10-26 09:00\nimported_at: 2026-10-26 09:00\n---\n\nWhy ${how.propose}.\n`)
  }
  // A build's last word is its review's, a later run than the one that started it.
  const last = b === 'implement' ? `run-review-${runs.length + 2}` : sessionId
  const spent = { startedAt: Date.now(), ...how.spent }
  if (how.hang) {
    runs.push({ sessionId, cardId: id, action: b, status: 'running', ...spent })
    write('runs.json', runs)
    setInterval(() => console.log('still working'), 50)
    await new Promise(() => {})
  }
  if (how.gates?.length) {
    runs.push({ sessionId, cardId: id, action: b, status: 'running', ...spent })
    write('runs.json', runs)
  }
  for (const gate of how.gates ?? []) {
    console.log(JSON.stringify({ kind: 'message', data: { text: `Waiting for ${path.basename(gate)}.` } }))
    while (!fs.existsSync(gate)) {
      if (read('runs.json', []).find((r) => r.sessionId === sessionId)?.status === 'stopped') process.exit(1)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  if (how.gates?.length) runs.pop()
  const evidence = how.trackExecution && { action: b, status: 'done', deliveryId: how.delivery?.id, resumeId: how.agentSession,
    cloudExecution: JSON.parse(process.env.AI4KANBAN_EXECUTION), pendingWrites: false }
  runs.push({ sessionId, cardId: id, result: how.result, ...spent, ...evidence }, ...(last !== sessionId ? [{ sessionId: last, cardId: id, result: how.landed ?? 'Landed it.', ...spent }] : []))
  write('runs.json', runs)
  if (how.reject) {
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('questions:', 'rejected: true\nquestions:'))
    fs.renameSync(file, path.join(board, '.archive', path.basename(file)))
  }
  if (how.failed) {
    const delivery = how.delivery ? { delivery: how.delivery } : {}
    console.log(JSON.stringify({ ok: false, error: { kind: 'run-failed', message: `run ${last.slice(0, 8)} ended error: ${how.failed}`, lastSessionId: last, ...delivery } }))
    process.exit(1)
  }
  const delivery = b !== 'implement' || how.delivery === null
    ? how.delivery
    : { id: 'd1', status: how.question ? 'active' : 'finished', ...how.delivery }
  if (delivery?.status === 'finished') {
    fs.renameSync(file, path.join(board, '.archive', path.basename(file)))
    write(`delivery-${id}.json`, delivery)
  }
  console.log(JSON.stringify({ ok: true, status: 'done', result: how.result, lastSessionId: last, ...(how.agentSession ? { agentSession: how.agentSession } : {}),
    ...(delivery ? { delivery } : {}) }))
} else if (a === 'delivery' && b === 'reconcile') {
  const id = Number(c)
  const how = plan.reconcile
  if (how) {
    const attempt = (read('reconcile-attempts.json', 0) || 0) + 1
    write('reconcile-attempts.json', attempt)
    const step = Array.isArray(how) ? how[Math.min(attempt - 1, how.length - 1)] : how
    if (step?.refuse) fail(step.refuse)
    console.log(JSON.stringify({ ok: true, ...step }))
  } else {
    const runs = read('runs.json', [])
    const live = runs.find((r) => r.cardId === id && r.status === 'running' && r.deliveryId)
    if (live) {
      console.log(JSON.stringify({ ok: true, kind: 'running', sessionId: live.sessionId, deliveryId: live.deliveryId, action: live.action }))
    } else {
      console.log(JSON.stringify({ ok: true, kind: 'none' }))
    }
  }
} else if (a === 'delivery' && b === 'release') {
  const how = plan.release ?? {}
  if (how.refuse) fail(how.refuse)
  write('released.json', { card: Number(c), deliveryId: how.deliveryId ?? 'd1' })
  console.log(JSON.stringify({ ok: true, released: true, deliveryId: how.deliveryId ?? 'd1' }))
} else if (a === 'delivery' && b === 'resume') {
  // `delivery` in FAKE_AKB: how carrying the card's ended delivery on goes (#2128).
  const how = plan.delivery ?? {}
  if (how.refuse) {
    console.log(JSON.stringify({ ok: false, error: { kind: 'run-refused', message: how.refuse, reason: how.reason, args: how.args } }))
    process.exit(1)
  }
  const file = cardOf(Number(c))
  const archived = file?.includes(`${path.sep}.archive${path.sep}`)
  if (how.landed && file && !archived) fs.renameSync(file, path.join(board, '.archive', path.basename(file)))
  const delivery = how.landed ? { id: 'd1', status: 'finished', ...how.result }
    : archived ? read(`delivery-${c}.json`, null) : null
  console.log(JSON.stringify({ ok: true, deliveryId: how.deliveryId ?? delivery?.id ?? 'd1', ...(delivery
    ? { landed: true, delivery }
    : { carryOn: how.carryOn ?? 'build' }) }))
} else if (a === 'run' && (b === 'resume' || b === 'log')) {
  const runs = read('runs.json', [])
  const previous = runs.find((r) => r.sessionId === c)
  if (!previous) fail('no such run')
  const how = plan.resume ?? {}
  if (how.refuse) fail(how.refuse)
  if (b === 'resume' && words.includes('--require-session') && !previous.resumeId) {
    console.log(JSON.stringify({ ok: false, error: { kind: 'run-refused', message: 'the original conversation cannot be resumed', reason: 'runNoSession' } }))
    process.exit(1)
  }
  const sessionId = b === 'resume' ? `resumed-${c}` : c
  if (b === 'resume') {
    runs.splice(runs.indexOf(previous), 1)
    runs.push({ ...previous, ...how.spent, sessionId, resumedFrom: c, status: 'done', startedAt: Date.now(), result: 'Continued it.' })
    write('runs.json', runs)
  }
  if (words.includes('--events')) console.log(JSON.stringify({ kind: 'message', data: { text: 'Continued the original conversation.' } }))
  const file = cardOf(previous.cardId)
  if (file && file.includes(`${path.sep}todo${path.sep}`)) fs.renameSync(file, path.join(board, '.archive', path.basename(file)))
  console.log(JSON.stringify({ ok: true, sessionId, status: 'done', result: 'Continued it.', agentSession: previous.resumeId,
    delivery: { id: how.deliveryId ?? previous.deliveryId, status: 'finished', commit: 'abc123', branch: 'main' } }))
} else if (a === 'delivery' && b === 'cancel') {
  // A discarded build (#61): its record keeps no checkout.
  const file = path.join(board, 'deliveries', `${c}.json`)
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'cancelled' }))
  console.log(JSON.stringify({ ok: true, deliveryId: c, discarded: true }))
} else if (a === 'run' && b === 'stop') {
  const runs = read('runs.json', [])
  const run = runs.find((r) => r.sessionId === c)
  if (!run) fail(`no run here answers to "${c}"`)
  if (run.status === 'running') {
    run.status = 'stopped'
    const chain = plan[run.action]?.chain ?? 0
    if (runs.filter((r) => r.action === run.action).length <= chain) {
      runs.push({ sessionId: `run-${run.action}-${runs.length + 1}`, cardId: run.cardId, action: run.action, status: 'running', startedAt: Date.now() })
    }
    write('runs.json', runs)
  }
  console.log(JSON.stringify({ ok: true, sessionId: c }))
} else if (a === 'review-memory') {
  // What a review writes: a workspace file and a project one, naming the tasks it read.
  const tasks = words.slice(words.indexOf('--task') + 1).filter((w, i, all) => !all.slice(0, i + 1).some((x) => x.startsWith('--')))
  // A batch with nothing to read starts no run (#185).
  if (plan['review-memory']?.empty) {
    console.log(JSON.stringify({ ok: true, action: 'review-memory', skipped: true }))
    process.exit(0)
  }
  const home = process.env.AI4KANBAN_HOME
  const chatOf = (t) => path.join(home, 'chats', `${t.split(':')[0]}.jsonl`)
  const said = tasks.filter((t) => fs.existsSync(chatOf(t))).map((t) => fs.readFileSync(chatOf(t), 'utf8').trim().split('\n').map((l) => JSON.parse(l).text).join(' / '))
  for (const [file, line] of [['memory/previews/coding/prompts/workspace/style.md', 'Style'], ['memory/previews/coding/prompts/project/rules.md', 'Writing']]) {
    fs.mkdirSync(path.dirname(path.join(board, file)), { recursive: true })
    fs.appendFileSync(path.join(board, file), `${line}: ${said.join(' | ')}\n`)
  }
  fs.writeFileSync(path.join(state, 'reviewed'), JSON.stringify(tasks))
  console.log(JSON.stringify({ ok: true, status: 'done', result: `Reviewed ${tasks.length}.` }))
} else if (a === 'review-dismissals') {
  // What a review reads, as the board lays it out, and the note it writes.
  const how = plan['review-dismissals'] ?? {}
  const input = process.env.AI4KANBAN_REJECTION_INPUT ?? board
  const list = (dir) => (fs.existsSync(path.join(input, dir)) ? fs.readdirSync(path.join(input, dir)).filter((n) => n.endsWith('.md')).map((n) => `${dir}/${n}`) : [])
  const seen = [...list('.archive/.sync'), ...list('triage/dismissed'), ...list('triage/archived')]
  fs.writeFileSync(path.join(state, 'learned'), JSON.stringify({ args: words, seen: Object.fromEntries(seen.map((f) => [f, fs.readFileSync(path.join(input, f), 'utf8')])) }))
  if (how.failed) {
    console.log(JSON.stringify({ ok: false, error: { kind: 'run-failed', message: how.failed } }))
    process.exit(1)
  }
  fs.mkdirSync(path.join(board, 'memory', 'agents', 'planner'), { recursive: true })
  fs.writeFileSync(path.join(board, 'memory', 'agents', 'planner', 'rejected.md'), '- **No mobile app**: we never build one (#9)\n')
  const runs = read('runs.json', [])
  runs.push({ sessionId: 'run-review-dismissals', cardId: null, startedAt: Date.now(), ...how.spent })
  write('runs.json', runs)
  console.log(JSON.stringify({ ok: true, status: 'done', result: 'Learned one.' }))
} else if (a === 'studio' && b === 'list') {
  const dir = path.join(board, 'studios')
  const ids = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  console.log(JSON.stringify({ ok: true, studios: ids.map((id) => ({ id, problems: plan.studioProblems ?? [] })), problems: [] }))
} else if (a === 'previews' && (!b || b.startsWith('--'))) {
  console.log(JSON.stringify({ ok: true, agents: [], problems: plan.specProblems ?? [] }))
} else if (a === 'reflect' || a === 'prune-memory' || a === 'describe-project' || (a === 'agent' && b === 'run')) {
  // A periodic agent (#2068): the note it writes, the task it works for, and a follow-up proposed.
  const name = a === 'agent' ? `${c}-${words[3]}` : a
  const how = plan[name] ?? {}
  fs.writeFileSync(path.join(state, 'periodic'), JSON.stringify({ args: words, task: process.env.AI4KANBAN_TASK ?? '', scheduled: process.env.AI4KANBAN_SCHEDULED_AGENTS }))
  if (how.failed) {
    console.log(JSON.stringify({ ok: false, error: { kind: 'run-failed', message: `run x ended error: ${how.failed}` } }))
    process.exit(1)
  }
  fs.mkdirSync(path.join(board, 'memory'), { recursive: true })
  fs.writeFileSync(path.join(board, 'memory', `${name}.md`), `${name} ran.\n`)
  // Pruning drops the memory of an agent the board does not have.
  const kept = path.join(board, 'memory', 'agents')
  if (name === 'prune-memory' && fs.existsSync(kept)) {
    for (const agent of fs.readdirSync(kept)) {
      if (!['planner', 'proposer'].includes(agent) && !fs.existsSync(path.join(board, 'agents', agent, 'AGENT.md'))) fs.rmSync(path.join(kept, agent), { recursive: true })
    }
  }
  if (how.propose) {
    fs.mkdirSync(path.join(board, 'triage'), { recursive: true })
    fs.writeFileSync(path.join(board, 'triage', 'proposed.md'), `---\nsource_id: derived-1\ntitle: ${how.propose}\n${how.studio === '' ? '' : `studio: ${how.studio ?? 'coding'}\n`}collected_at: 2026-10-26 09:00\nimported_at: 2026-10-26 09:00\n---\n\nWhy ${how.propose}.\n`)
  }
  const runs = read('runs.json', [])
  runs.push({ sessionId: `run-${name}`, cardId: null, startedAt: Date.now(), ...how.spent })
  write('runs.json', runs)
  console.log(JSON.stringify({ ok: true, status: 'done', result: `${name} done.` }))
} else if (a === 'run' && b === 'list') {
  const card = Number(flag('--card'))
  const all = read('runs.json', [])
  console.log(JSON.stringify({ ok: true, runs: flag('--card') ? all.filter((r) => r.cardId === card) : all }))
} else {
  fail(`the fake has no ${words.join(' ')}`)
}
