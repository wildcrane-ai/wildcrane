import { readLanguage } from '../machine/settings'
import type { Language } from '../machine/types'

export const LANGUAGE_ENV = 'AI4KANBAN_LANGUAGE'

export const SYSTEM_LANGUAGE_ZH = '用中文回复。给任务创建者看的用中文，工作台的最终产物沿用项目语言。'
export const SYSTEM_LANGUAGE_EN = "Reply in English. Write for the task creator in English; the studio's final artifacts follow the project's language."

export const isSystemLanguage = (text: string): boolean => text === SYSTEM_LANGUAGE_ZH || text === SYSTEM_LANGUAGE_EN
export const languageCode = (value: unknown): Language | null => value === 'zh' || value === 'en' ? value : null

export function runLanguage(): Language | null {
  if (process.env[LANGUAGE_ENV] !== undefined) return languageCode(process.env[LANGUAGE_ENV])
  return readLanguage()
}

export const translating = (): boolean => runLanguage() === 'zh'
export const systemLanguage = (language: Language | null): string => language === 'zh' ? SYSTEM_LANGUAGE_ZH : language === 'en' ? SYSTEM_LANGUAGE_EN : ''

export function cloudLanguage(input: { language?: Language | null; test?: boolean }): Language | null {
  return input.test ? null : languageCode(input.language)
}
