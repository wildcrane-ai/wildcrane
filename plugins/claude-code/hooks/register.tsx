import type { EngineInterface, Register } from 'claude-code'

type Lang = 'zh' | 'en'
type Opened = { url?: string; opened?: boolean; notice?: string; error?: string }

const COPY = {
  zh: {
    opened: (url: string) => `已在浏览器打开 WildCrane 设置：${url}`,
    notOpened: (url: string) => `浏览器没能打开，请手动访问 WildCrane 设置：${url}`,
    offline: 'WildCrane 设置没能打开。重启 Claude Code 后重试。',
  },
  en: {
    opened: (url: string) => `Opened WildCrane settings in the browser: ${url}`,
    notOpened: (url: string) => `The browser didn't open. Visit WildCrane settings at ${url}`,
    offline: "WildCrane settings couldn't open. Restart Claude Code and try again.",
  },
}

/** Claude Code's `language` setting first, then the system's. */
function langOf(setting: unknown, system: string | undefined): Lang {
  if (typeof setting === 'string' && setting) return /^(zh|chinese)|中文/i.test(setting) ? 'zh' : 'en'
  return /^zh/i.test(system ?? '') ? 'zh' : 'en'
}

/** The Runner opens this computer's settings; `panel.key` guards its tool. */
async function openSettings($: EngineInterface, lang: Lang): Promise<Opened> {
  try {
    const connected = await $.mcp.connect('wildcrane')
    if (!connected.isConnected) return { error: 'offline' }
    const home = (await $.env.get('WILDCRANE_HOME')) || `${await $.env.get('HOME')}/.wildcrane`
    const key = (await $.fs.read(`${home}/plugin/panel.key`)).trim()
    const cwd = await $.session.cwd()
    const result = await $.mcp.call(connected.server, 'wildcrane_panel', { key, action: 'openSettings', cwd, lang })
    const block = result.content.find((b) => b.type === 'text') as { text?: string } | undefined
    return JSON.parse(block?.text ?? '{}') as Opened
  } catch {
    return { error: 'offline' }
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    // A WildCrane job's own Claude session has no settings to open.
    if (await $.env.get('WILDCRANE_JOB')) return next(e)
    await $.command.register({ name: 'wildcrane', description: '打开 WildCrane 本机设置' })
    return next(e)
  })

  on('command.run', { command: 'wildcrane' }, async ($) => {
    const settings = (await $.settings.read()) as { language?: unknown }
    const lang = langOf(settings.language, await $.env.get('LANG'))
    const c = COPY[lang]
    const answer = await openSettings($, lang)
    const line = answer.url ? (answer.opened ? c.opened(answer.url) : c.notOpened(answer.url)) : c.offline
    return { text: answer.notice ? `${line}\n${answer.notice}` : line }
  })

  // The command's tool: kept out of the model's tool list, and asks nobody.
  on('tool.describe', async ($, e, next) => {
    if (!e.tool.endsWith('__wildcrane_panel')) return next(e)
    return { description: e.description, isDeferred: true }
  })

  on('tool.check', async ($, e, next) => {
    if (!e.tool.endsWith('__wildcrane_panel')) return next(e)
    return { decision: 'allow' }
  })
}
