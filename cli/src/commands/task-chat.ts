import { setTimeout as delay } from 'node:timers/promises'
import { cloud, taskRef, taskUrl, type TaskLocation } from './task'
import { answer } from '../lib/board-cli'
import { BoardError, CommandExit, say } from '../lib/io'
import { readLanguage } from '../lib/machine/settings'

interface Message {
  id: string
  role: string
  body: string
  created_at: string
  stopped?: boolean
  image_names?: string[]
  [field: string]: unknown
}
interface Chat {
  status: string
  job: string | null
  failure?: string | null
  execution?: { phase?: string; startedAt?: string; firstContentAt?: string; stopRequested?: boolean; [field: string]: unknown } | null
  messages: Message[]
}
interface Task { key: string; status: string }
interface Job { id: string; state: string; outcome: string | null; reason?: string | null; reply?: string | null; finishedAt?: string | null }
interface Reply { id: string | null; state: string; failure: string | null; execution: Chat['execution'] }
interface Snapshot { task: Task; reply: Reply; messages: Message[]; total: number; truncated: boolean }
export interface ChatOptions extends TaskLocation { limit?: number; all?: boolean; follow?: boolean; stop?: boolean; json?: boolean }

const text = (en: string, zh: string) => readLanguage() === 'zh' ? zh : en
const states: Record<string, [string, string]> = {
  idle: ['Idle', '空闲'], queued: ['Queued', '排队中'], starting: ['Starting', '启动中'], replying: ['Replying', '回复中'],
  stopping: ['Stopping', '正在停止'], done: ['Done', '已完成'], stopped: ['Stopped', '已停止'], failed: ['Failed', '失败'],
  offline: ['Offline', '离线'], conflict: ['Conflict', '冲突'],
}
const label = (state: string) => states[state] ? text(...states[state]!) : state
const active = (reply: Reply) => !!reply.id && ['queued', 'starting', 'replying', 'stopping'].includes(reply.state)
const failed = (reply: Reply) => ['failed', 'conflict', 'offline'].includes(reply.state)

export function validateChatOptions(message: string[], opts: ChatOptions): void {
  if ((opts.limit !== undefined && opts.all) ||
      (message.length && (opts.limit !== undefined || opts.all || opts.follow || opts.stop)) ||
      (opts.stop && (opts.limit !== undefined || opts.all || opts.follow))) {
    throw new BoardError('Use a message, history options [--limit <n> | --all] [--follow], or --stop separately.', { kind: 'bad-args' })
  }
}

function replyOf(chat: Chat): Reply {
  const execution = chat.execution ?? null
  const last = chat.messages.at(-1)
  const state = chat.job && execution?.stopRequested ? 'stopping'
    : chat.status === 'runner_offline' ? 'offline'
    : chat.status !== 'idle' && !['queued', 'replying'].includes(chat.status) ? chat.status
    : chat.status === 'replying' ? (execution?.startedAt || execution?.firstContentAt || execution?.phase === 'started' ? 'replying' : 'starting')
    : chat.status === 'queued' ? 'queued'
    : last?.role === 'agent' ? (last.stopped ? 'stopped' : 'done') : 'idle'
  return { id: chat.job, state, failure: chat.failure ?? null, execution }
}

function snapshot(task: Task, chat: Chat, opts: ChatOptions): Snapshot {
  const messages = opts.all ? chat.messages : chat.messages.slice(-(opts.limit ?? 20))
  return { task: { key: task.key, status: task.status }, reply: replyOf(chat), messages, total: chat.messages.length, truncated: messages.length < chat.messages.length }
}

function showReply(reply: Reply): void {
  say(`${text('Chat reply', '聊天回复')}: ${label(reply.state)}`)
  if (reply.execution) say(`${text('Progress', '进展')}: ${JSON.stringify(reply.execution)}`)
  if (reply.failure) say(reply.failure)
}

function showSnapshot(value: Snapshot): void {
  say(`${value.task.key}  ${taskUrl(value.task.key)}`)
  say(`${text('Task execution', '任务执行')}: ${value.task.status}`)
  showReply(value.reply)
  if (!value.total) say(text('No chat history.', '暂无聊天记录。'))
  for (const m of value.messages) {
    say(`\n${m.created_at}  ${m.role === 'agent' ? text('AI', 'AI') : text('User', '用户')}${m.stopped ? text(' [stopped]', ' [已停止]') : ''}\n${m.body}`)
    if (m.image_names?.length) say(m.image_names.join(', '))
  }
  if (value.truncated) say(text(`Showing ${value.messages.length} of ${value.total} messages.`, `显示 ${value.total} 条中的 ${value.messages.length} 条。`))
}

async function read(id: string, opts: ChatOptions, signal?: AbortSignal): Promise<{ route: string; chat: Chat; value: Snapshot }> {
  const route = `/v1/tasks/${encodeURIComponent(await taskRef(id, opts))}`
  const [task, chat] = await Promise.all([cloud<Task>('GET', route, undefined, signal), cloud<Chat>('GET', `${route}/chat`, undefined, signal)])
  return { route, chat, value: snapshot(task, chat, opts) }
}

function endedReply(before: Reply, job: Job): Reply {
  return { id: before.id, state: job.outcome ?? 'failed', failure: ['failed', 'conflict'].includes(job.outcome ?? '') ? job.reason ?? null : null,
    execution: { ...before.execution, ...(job.finishedAt ? { endedAt: job.finishedAt } : {}) } }
}

export async function taskChatRead(id: string, opts: ChatOptions): Promise<Record<string, unknown>> {
  const { route, value } = await read(id, opts)
  if (!opts.stop) {
    showSnapshot(value)
    return { ...value }
  }
  const target = value.reply.id
  let stop: { id: string | null; state: string } = { id: target, state: 'not_running' }
  if (target) {
    const chat = await cloud<Chat>('POST', `${route}/chat/stop`, { job: target })
    if (chat.job === target && replyOf(chat).state === 'stopping') {
      value.reply = replyOf(chat)
      stop.state = 'requested'
    } else {
      const { job } = await cloud<{ job: Job | null }>('GET', `/v1/runner/jobs/${encodeURIComponent(target)}`)
      if (job?.state === 'finished') value.reply = endedReply(value.reply, job)
      stop.state = job?.state === 'finished' && job.outcome === 'stopped' ? 'stopped' : 'superseded'
    }
  }
  say(`${value.task.key}  ${taskUrl(value.task.key)}`)
  say(`${text('Task execution', '任务执行')}: ${value.task.status}`)
  showReply(value.reply)
  say(({ requested: text('Stop requested.', '已请求停止。'), stopped: text('Reply stopped.', '回复已停止。'),
    not_running: text('No active chat reply.', '暂无活动聊天回复。'), superseded: text('The target reply ended or was replaced.', '目标回复已结束或被替换。') })[stop.state])
  return { task: value.task, reply: value.reply, stop }
}

/** Only an explicit follow owns a socket and temporary status reads. */
export async function taskChatFollow(id: string, opts: ChatOptions): Promise<void> {
  let reply: Reply | undefined
  let body: string | null = null
  const controller = new AbortController()
  const interrupted = () => controller.abort()
  process.on('SIGINT', interrupted)
  let close = () => {}
  const emit = (value: Record<string, unknown>) => { if (opts.json) answer(value) }
  try {
    const first = await read(id, opts, controller.signal)
    reply = first.value.reply
    emit({ ok: true, type: 'snapshot', ...first.value })
    if (!opts.json) showSnapshot(first.value)
    if (active(reply)) {
      const target = reply.id!
      const { watchReplyLog } = await import('../lib/cloud/reply-log')
      let streamError: BoardError | null = null
      close = watchReplyLog(target, (event) => {
        emit({ ok: true, type: 'event', replyId: target, event })
        if (!opts.json) {
          const data = event.data ?? {}
          const content = event.text || (typeof data.text === 'string' ? data.text : '')
          if (content) say(content)
          else if (event.kind === 'phase' && data.phase) say(`${text('Progress', '进展')}: ${data.phase}`)
          else if (event.kind === 'tool_call' || event.kind === 'tool_call_update') {
            say(`${text('Activity', '当前活动')}: ${[data.title || data.target || data.kind, data.status].filter(Boolean).join(' — ')}`)
          }
        }
      }, (error) => { streamError = error })
      while (active(reply)) {
        if (controller.signal.aborted) throw new CommandExit(130)
        if (streamError) throw streamError
        const [held, chat] = await Promise.all([
          cloud<{ job: Job | null }>('GET', `/v1/runner/jobs/${encodeURIComponent(target)}`, undefined, controller.signal),
          cloud<Chat>('GET', `${first.route}/chat`, undefined, controller.signal),
        ])
        if (!held.job) throw new BoardError('The followed reply is no longer available.', { kind: 'follow_disconnected' })
        let next: Reply
        if (held.job.state === 'finished') {
          next = endedReply(reply, held.job)
          body = held.job.reply ?? null
        } else if (chat.job === target) {
          next = replyOf(chat)
        } else {
          // A later reply never becomes this follow's target; wait for the original job's result.
          next = reply
        }
        if (JSON.stringify(next) !== JSON.stringify(reply)) {
          reply = next
          emit({ ok: true, type: 'status', replyId: target, reply })
          if (!opts.json) showReply(reply)
        }
        if (!active(reply)) {
          break
        }
        await delay(1000, undefined, { signal: controller.signal })
      }
    } else {
      body = first.chat.messages.at(-1)?.role === 'agent' ? first.chat.messages.at(-1)!.body : null
    }
    if (failed(reply)) throw new BoardError(reply.failure || `Chat reply: ${reply.state}.`, { kind: 'reply_failed' })
    emit({ ok: true, type: 'result', reply, body })
    if (!opts.json && body !== null) say(body)
  } catch (error) {
    const code = controller.signal.aborted ? 130 : error instanceof CommandExit ? error.exitCode : 1
    const failure = error instanceof BoardError ? error : new BoardError(code === 130 ? 'Follow interrupted.' : 'Could not follow the chat reply.', { kind: code === 130 ? 'interrupted' : 'follow_disconnected' })
    emit({ ok: false, type: 'result', reply: reply ?? null, body, error: { kind: failure.kind, message: failure.message, ...failure.details } })
    if (!opts.json) say(failure.message)
    throw new CommandExit(code)
  } finally {
    close()
    process.removeListener('SIGINT', interrupted)
  }
}
