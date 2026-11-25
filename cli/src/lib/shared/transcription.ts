// Whisper language codes: https://github.com/openai/whisper/blob/main/whisper/tokenizer.py
const languages = new Set((
  'en zh de es ru ko fr ja pt tr pl ca nl ar sv it id hi fi vi he uk el ms cs ro da hu ta no th ur hr bg lt la mi ml cy sk te fa lv bn sr az sl kn et mk br eu is hy ne mn bs kk sq sw gl mr pa si km sn yo so af oc ka be tg sd gu am yi lo uz fo ht ps tk nn mt sa lb my bo tl mg as tt haw ln ha ba jw su yue'
).split(' '))

export const MAX_TRANSCRIPTION_BYTES = 20 * 1024 * 1024

export function transcriptionLanguage(value: unknown): value is string {
  return typeof value === 'string' && (value === 'auto' || languages.has(value))
}

export interface Transcript {
  language: string | null
  segments: { id: string; text: string; start_ms: number; end_ms: number }[]
}

export type TranscriptionJob = { id: string } & (
  | { status: 'queued' | 'running' }
  | { status: 'done'; result: Transcript; usage?: {
      billable_seconds: number
      apiCharge?: { rateId: string; pricingVersion: string; usage: { quantity: number; unit: 'second' }; amountUsd: string }
      credits?: number
    } }
  | { status: 'failed'; error: { code: 'transcription_failed'; message: string } }
)
