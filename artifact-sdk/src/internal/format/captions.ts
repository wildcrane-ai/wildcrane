export type Cue = { start: number; end: number; text: string };

const TIME = '(?:[0-9]{2,}:)?[0-5][0-9]:[0-5][0-9][.,][0-9]{3}';
const TIMINGS = new RegExp(`^[ \\t]*(${TIME})[ \\t]+-->[ \\t]+(${TIME})(?:[ \\t].*)?$`);

function seconds(timestamp: string): number {
  return timestamp.replace(',', '.').split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: '\u00a0', lrm: '\u200e', rlm: '\u200f' };

function cueText(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:[biucv]|ruby|rt|lang|font)(?:[.\s][^<>]*)?>|<[\d:.]+>/gi, '')
    .replace(/&(amp|lt|gt|nbsp|lrm|rlm);/g, (_, name: string) => entities[name]!)
    .trim();
}

export function parseCues(source: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n(?:[ \t]*\n)+/)) {
    const lines = block.split('\n');
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/.test(lines[0]!)) continue;
    const first = lines[0]!.includes('-->') ? 0 : 1;
    const times = TIMINGS.exec(lines[first] ?? '');
    if (!times) continue;
    const start = seconds(times[1]!);
    const end = seconds(times[2]!);
    const text = cueText(lines.slice(first + 1).join('\n'));
    if (Number.isFinite(end) && start < end && text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}
