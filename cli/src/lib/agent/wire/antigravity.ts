import path from 'node:path'
import type { ContextWindow, TokenUsage } from '../types'
import { makeFailure, type ExecutionFailure } from '../retry'
import { priceUsd } from '../prices'
import { translating } from '../language'
import { createEventCollector, type ToolKind } from './events'
import { obj, str, num } from './json'
import { createLineReader, frame, type StreamRenderer } from './stream'
import { antigravityRecordedContextLimit, antigravityRecordedModels } from './antigravity-session'

const CONTEXT_LOOK_EVERY_MS = 250

const KINDS: Record<string, ToolKind> = {
  run_command: 'execute', command_status: 'execute', send_command_input: 'execute',
  read_file: 'read', view_file: 'read', list_dir: 'read', grep_search: 'search', find_by_name: 'search',
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

const imagePath = (target: string) => /\.(?:png|jpe?g|gif|webp|bmp|tiff?|svg)$/i.test(target)

export function createAntigravityRenderer(expectedSession?: string, cwd = process.cwd()): StreamRenderer {
  let session: string | undefined = expectedSession
  let model: string | undefined
  let partial = ''
  let final: string | undefined
  let failure: string | undefined
  let classified: ExecutionFailure | undefined
  let imageFailure: string | undefined
  let requiredImages: string[] = []
  const readImages = new Set<string>()
  const imageErrors = new Map<string, string>()
  const imageError = (target: string, reason: string) => translating()
    ? `Antigravity 无法读取图片 ${target}：${reason}` : `Antigravity could not read image ${target}: ${reason}`
  let terminal = false
  let offStream: string | undefined
  let stderr = ''
  let context: ContextWindow | undefined
  let contextStep = -1
  let contextPrompt = -1
  let contextLimitStep = -1
  let contextLimitLookedAt = 0
  const resolveContextLimit = (now: boolean) => {
    if (!context || !session || contextStep < 0 || contextLimitStep === contextStep) return
    const at = Date.now()
    if (!now && at - contextLimitLookedAt < CONTEXT_LOOK_EVERY_MS) return
    contextLimitLookedAt = at
    const limit = antigravityRecordedContextLimit(session, contextStep, contextPrompt)
    if (limit !== undefined) {
      context = { used: context.used, limit }
      contextLimitStep = contextStep
    }
  }
  const started = Date.now()
  let cost: number | undefined
  let incomplete = false
  const priced = new Set<number>()
  let prompt = -1
  const pendingCosts = new Map<number, { prompt: number; usage: TokenUsage }>()
  const estimate = (id: string | undefined, usage: TokenUsage) => {
    const usd = priceUsd('antigravity', id, usage, started)
    if (usd === undefined) incomplete = true
    else cost = (cost ?? 0) + usd
  }
  const countCost = (step: Record<string, unknown>) => {
    const index = step.step_index
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || priced.has(index) || (!model && index <= prompt)) return
    priced.add(index)
    const u = obj(step.usage)
    const valid = [u.input_tokens, u.output_tokens, u.cache_read_tokens].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    if (!valid || (!model && prompt < 0)) incomplete = true
    else if (model) estimate(model, usageOf(u))
    else pendingCosts.set(index, { prompt, usage: usageOf(u) })
  }
  let used: TokenUsage | undefined
  let turnUsage = zero()
  let previous: TokenUsage | undefined
  const counted = new Set<number>()
  const calls = new Set<string>()
  const closed = new Set<string>()
  const events = createEventCollector()
  const fail = (reason: string, code = 'provider_failed') => {
    failure = failureHint(reason)
    classified = makeFailure('runtime', failure, { code, detail: reason })
    events.error(failure)
  }
  const reader = createLineReader((line) => {
    const e = frame(line)
    if (!e) {
      offStream = line.trim() || offStream
      return `${line}\n`
    }
    if (e.event === 'init') {
      const got = str(e.conversation_id)
      if (expectedSession && got !== expectedSession) { fail(translating() ? 'Antigravity 未续接指定会话，请检查本机原会话后重试。' : 'Antigravity did not resume the requested conversation.', 'session_mismatch'); return '' }
      session = got || session
      model = str(obj(e.init).model) || model
      return ''
    }
    if (e.event === 'step_update') {
      const step = obj(e.step_update)
      const got = str(step.conversation_id)
      if ((expectedSession && got !== expectedSession) || (session && got && got !== session)) return ''
      session = got || session
      const id = String(step.step_index ?? '')
      if (step.state === 'DONE' && step.step_type === 'user_input' && typeof step.step_index === 'number'
        && Number.isSafeInteger(step.step_index) && step.step_index > prompt) prompt = step.step_index
      if (step.state === 'DONE' && ['agent_response', 'checkpoint'].includes(str(step.step_type))) countCost(step)
      if (step.step_type === 'agent_response') {
        const text = str(step.text_delta)
        partial += text
        if (text) events.update({ sessionUpdate: 'agent_message_chunk', content: { text } })
        const index = num(step.step_index)
        if (step.state === 'DONE' && Number.isSafeInteger(index) && step.step_index === index && index > contextStep) {
          contextStep = index
          contextPrompt = prompt
          contextLimitStep = -1
          contextLimitLookedAt = 0
          const u = obj(step.usage)
          // agy counts fresh input and cache reads separately; result.usage is cumulative.
          const counts = [u.input_tokens, u.cache_read_tokens]
          const promptTokens = counts.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)
            ? num(u.input_tokens) + num(u.cache_read_tokens) : 0
          context = promptTokens > 0 && Number.isFinite(promptTokens) ? { used: promptTokens } : undefined
        }
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
        if (['DONE', 'ERROR', 'CANCELED', 'INTERRUPTED'].includes(str(step.state)) && !closed.has(id)) {
          closed.add(id)
          const failed = !!reason || step.state !== 'DONE'
          if (['read_file', 'view_file'].includes(name) && imagePath(target)) {
            const file = path.resolve(cwd, target)
            if (failed) {
              imageErrors.set(file, reason || str(step.state))
              out += `\n${imageError(target, reason || str(step.state))}\n`
            } else {
              readImages.add(file)
              imageErrors.delete(file)
            }
          }
          events.toolResult(id, failed ? 'failed' : 'completed', str(tool.output) || reason)
        }
        return out
      }
      return ''
    }
    if (e.event === 'result') {
      const result = obj(e.result)
      if (expectedSession && str(result.conversation_id) && result.conversation_id !== expectedSession) { fail(translating() ? 'Antigravity 未续接指定会话，请检查本机原会话后重试。' : 'Antigravity did not resume the requested conversation.', 'session_mismatch'); terminal = true; return '' }
      session ||= str(result.conversation_id) || undefined
      resolveContextLimit(true)
      terminal = true
      final = typeof result.response === 'string' ? result.response : undefined
      const total = usageOf(result.usage)
      // On the first resumed result, only this prompt's steps give a known baseline.
      used = previous
        ? { input: Math.max(0, total.input - previous.input), output: Math.max(0, total.output - previous.output), cacheRead: Math.max(0, total.cacheRead - previous.cacheRead), cacheCreation: 0 }
        : num(result.num_turns) === 1 ? total : turnUsage
      previous = total
      if (!Object.values(used).some(n => n > 0)) used = undefined
      const missing = requiredImages.length
        ? requiredImages.filter(file => !readImages.has(file)) : [...imageErrors.keys()]
      imageFailure = missing.length ? missing.map(file => imageError(file, imageErrors.get(file)
        || (translating() ? '本轮未成功读取所需图片。' : 'Required image was not successfully read this turn.'))).join('\n') : undefined
      if (imageFailure) events.error(imageFailure)
      readImages.clear()
      imageErrors.clear()
      if (Array.isArray(result.denied_actions) && result.denied_actions.length) fail(translating() ? 'Antigravity 权限拒绝，请检查权限规则后重试。' : 'Antigravity permission denied. Check permission rules, then retry.', 'permission_denied')
      else if (!failure && (typeof result.response !== 'string' || result.status !== 'SUCCESS' || str(result.error) || (result.finished_reason && result.finished_reason !== 'completed' && result.finished_reason !== 'success'))) {
        fail(result.status === 'CANCELED' ? `Antigravity: CANCELED${result.error ? `: ${str(result.error)}` : ''}` : str(result.error) || `Antigravity: ${str(result.status) || 'missing status'}`)
      }
      events.end()
      turnUsage = zero()
      counted.clear()
      return failure || imageFailure ? `\n[error] ${failure || imageFailure}\n` : ''
    }
    return ''
  })
  return {
    push: reader.push,
    setRequiredImages(files) { requiredImages = files.filter(imagePath).map(file => path.resolve(cwd, file)) },
    flush() {
      const text = reader.flush()
      resolveContextLimit(true)
      if (pendingCosts.size) {
        const models = session ? antigravityRecordedModels(session, pendingCosts) : undefined
        for (const [index, { usage }] of pendingCosts) estimate(models?.get(index), usage)
        pendingCosts.clear()
      }
      if (!terminal) {
        incomplete = true
        const diagnostics = [stderr.trim(), offStream?.match(/^(?:error:|rpc error:|API error\b)/i) ? offStream : undefined]
        if (!failure) fail(diagnostics.find(Boolean) || (translating() ? 'Antigravity 未返回最终结果，请检查日志后重试。' : 'Antigravity returned no final result. Check the log, then retry.'), 'result_missing')
      }
      events.end()
      return text
    },
    stderr(chunk) {
      stderr = (stderr + chunk).slice(-16_000)
    },
    result: () => final || (failure ? partial || undefined : final),
    resumeId: () => session,
    model: () => model,
    usage: () => used,
    costUsd: () => cost,
    costIncomplete: () => incomplete || undefined,
    context: () => {
      resolveContextLimit(false)
      return context
    },
    failure: () => failure || imageFailure,
    terminalFailure: () => terminal && !!classified,
    executionFailure: () => classified ?? (imageFailure ? makeFailure('runtime', imageFailure, { code: 'image_read_failed', detail: imageFailure }) : undefined),
    events: events.events,
    activity: events.activity,
  }
}
