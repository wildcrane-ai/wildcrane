import type { TokenUsage } from '../types'
import { translating } from '../language'
import { createEventCollector, type ToolKind } from './events'
import { obj, str, num } from './json'
import { createLineReader, frame, type StreamRenderer } from './stream'

const KINDS: Record<string, ToolKind> = {
  run_command: 'execute', command_status: 'execute', send_command_input: 'execute',
  view_file: 'read', list_dir: 'read', grep_search: 'search', find_by_name: 'search',
  write_file: 'edit', write_to_file: 'edit', replace_file_content: 'edit', multi_replace_file_content: 'edit',
  read_url_content: 'fetch', search_web: 'fetch',
}
const zero = (): TokenUsage => ({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0 })
const usageOf = (raw: unknown): TokenUsage => {
  const u = obj(raw)
  return { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_tokens), cacheCreation: 0 }
}
const add = (a: TokenUsage, b: TokenUsage): TokenUsage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheCreation: 0 })

function failureHint(reason: string): string {
  const zh = translating()
  const hint = /authentication (?:required|failed)|not (?:logged|signed) in|unauthenticated|unauthorized|invalid credentials/i.test(reason)
    ? zh ? '请在本机运行 agy 登录后重试。' : 'Run agy on this computer to sign in, then retry.'
    : /invalid model|model.*(?:unavailable|not found|not recognized)/i.test(reason)
      ? zh ? '请运行 agy models，选择可用模型后重试。' : 'Run agy models and choose an available model, then retry.'
      : /quota|rate.?limit|resource.exhausted|credits|429/i.test(reason)
        ? zh ? '请等待额度恢复，或检查 Antigravity 账号额度后重试。' : 'Wait for the limit to reset or check your Antigravity credits, then retry.'
        : /network|connection|unavailable|deadline|timeout|timed out|dial tcp|DNS|502|503/i.test(reason)
          ? zh ? '请检查网络连接后重试。' : 'Check the network connection, then retry.'
          : /permission|denied|soft.den/i.test(reason)
            ? zh ? '请检查 Antigravity 的权限规则后重试。' : 'Check Antigravity permission rules, then retry.'
            : ''
  return hint ? `${reason}\n${hint}` : reason
}

export function createAntigravityRenderer(expectedSession?: string): StreamRenderer {
  let session: string | undefined = expectedSession
  let model: string | undefined
  let final: string | undefined
  let failure: string | undefined
  let terminal = false
  let offStream: string | undefined
  let stderr = ''
  let used: TokenUsage | undefined
  let turnUsage = zero()
  let previous: TokenUsage | undefined
  const counted = new Set<number>()
  const calls = new Set<string>()
  const closed = new Set<string>()
  const events = createEventCollector()
  const fail = (reason: string) => { failure = failureHint(reason); events.error(failure) }
  const reader = createLineReader((line) => {
    const e = frame(line)
    if (!e) { offStream = line.trim() || offStream; return `${line}\n` }
    if (e.event === 'init') {
      const got = str(e.conversation_id)
      if (expectedSession && got !== expectedSession) { fail(translating() ? 'Antigravity 未续接指定会话，请检查本机原会话后重试。' : 'Antigravity did not resume the requested conversation.'); return '' }
      session = got || session
      model = str(obj(e.init).model) || model
      return ''
    }
    if (e.event === 'step_update') {
      const step = obj(e.step_update)
      if (expectedSession && str(step.conversation_id) !== expectedSession) return ''
      session = str(step.conversation_id) || session
      const id = String(step.step_index ?? '')
      if (step.step_type === 'agent_response') {
        const text = str(step.text_delta)
        if (text) events.update({ sessionUpdate: 'agent_message_chunk', content: { text } })
        const index = num(step.step_index)
        if (step.state === 'DONE' && step.usage && !counted.has(index)) {
          counted.add(index)
          turnUsage = add(turnUsage, usageOf(step.usage))
          used = turnUsage
        }
        return text
      }
      if (step.step_type === 'tool') {
        const tool = obj(step.tool_info)
        const name = str(tool.name) || str(step.tool_name) || 'tool'
        const p = obj(tool.parameters)
        const target = str(p.CommandLine) || str(p.Path) || str(p.TargetFile) || str(p.AbsolutePath) || str(p.Query)
        let out = ''
        if (!calls.has(id)) {
          calls.add(id)
          events.toolCall(id, name, KINDS[name] ?? 'other', target)
          out = `\n⏺ ${name}${target ? ` ${target}` : ''}\n`
        }
        const error = obj(tool.error)
        const reason = str(error.message) || str(error.type)
        if (reason && /permission|denied|soft.den/i.test(reason)) fail(reason)
        if (['DONE', 'ERROR', 'CANCELED', 'INTERRUPTED'].includes(str(step.state)) && !closed.has(id)) {
          closed.add(id)
          events.toolResult(id, reason || step.state !== 'DONE' ? 'failed' : 'completed', str(tool.output) || reason)
        }
        return out
      }
      return ''
    }
    if (e.event === 'result') {
      const result = obj(e.result)
      if (expectedSession && str(result.conversation_id) && result.conversation_id !== expectedSession) { fail(translating() ? 'Antigravity 未续接指定会话，请检查本机原会话后重试。' : 'Antigravity did not resume the requested conversation.'); terminal = true; return '' }
      session = str(result.conversation_id) || session
      terminal = true
      final = typeof result.response === 'string' ? result.response : undefined
      const total = usageOf(result.usage)
      // On the first resumed result, only this prompt's steps give a known baseline.
      used = previous
        ? { input: Math.max(0, total.input - previous.input), output: Math.max(0, total.output - previous.output), cacheRead: Math.max(0, total.cacheRead - previous.cacheRead), cacheCreation: 0 }
        : num(result.num_turns) === 1 ? total : turnUsage
      previous = total
      if (!Object.values(used).some(n => n > 0)) used = undefined
      if (Array.isArray(result.denied_actions) && result.denied_actions.length) fail(translating() ? 'Antigravity 权限拒绝，请检查权限规则后重试。' : 'Antigravity permission denied. Check permission rules, then retry.')
      if (typeof result.response !== 'string' || result.status !== 'SUCCESS' || str(result.error) || (result.finished_reason && result.finished_reason !== 'completed' && result.finished_reason !== 'success')) {
        fail(str(result.error) || `Antigravity: ${str(result.status) || 'missing status'}`)
      }
      events.end()
      turnUsage = zero()
      counted.clear()
      return failure ? `\n[error] ${failure}\n` : ''
    }
    return ''
  })
  return {
    push: reader.push,
    flush() {
      const text = reader.flush()
      if (!terminal) fail(translating() ? 'Antigravity 未返回最终结果，请检查日志后重试。' : 'Antigravity returned no final result. Check the log, then retry.')
      events.end()
      return text
    },
    stderr(chunk) {
      stderr = (stderr + chunk).slice(-16_000)
      if (/soft.denied|auto-denied|permission (?:denied|required)|denied by.*(?:policy|rule)|requires? (?:user )?(?:approval|permission)/i.test(stderr)) fail(stderr.trim())
    },
    result: () => final,
    resumeId: () => session,
    model: () => model,
    usage: () => used,
    failure: () => failure,
    offStream: () => offStream,
    events: events.events,
  }
}
