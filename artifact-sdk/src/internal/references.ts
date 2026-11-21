// 卡片正文里的资源引用与文件类型；此模块不依赖 Node 或浏览器。
/** A file the card body names, with the types a JSON file there may be. */
export type Source = { src: string; types: string[] };
const STORYBOARD = ['storyboard'];
const STUDIO = ['studio'];
// 排列里的 JSON：Asset 能画的类型，或需要拒绝嵌套的分镜与对比。
const ARRANGED = ['storyboard', 'compare', 'spritesheet', 'studio'];
// Any other JSON stays a plain file.
const ASSET = ['spritesheet', 'asset'];
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function visibleBody(body: string): string {
  const lines = body.replace(/<!--[^]*?-->/g, '').split(/\r?\n/);
  let fence = '';
  let inTag = false;
  const visible: string[] = [];
  for (const line of lines) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (delimiter && delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = '';
      visible.push(''); continue;
    }
    if (delimiter) { fence = delimiter; visible.push(''); continue; }
    const kept = inTag || !/^(?: {4}|\t)/.test(line);
    visible.push(kept ? line : '');
    if (kept && /^ {0,3}<(?:Asset|Mockup|Compare|Storyboard|Studio)\b/.test(line)) inTag = true;
    if (line.includes('/>')) inTag = false;
  }
  return visible.join('\n').replace(/(`+)[^]*?\1/g, '');
}

const TAG = /<(Asset|Mockup|Compare|Storyboard|Studio)\b([^<>]*?)\/>/g;

function* componentTags(text: string) {
  const blocks = text.matchAll(/^ {0,3}(?:<(?:Asset|Mockup|Compare|Storyboard|Studio)\b[^<>]*?\/>[ \t]*(?:\n[ \t]*)?)+$/gm);
  for (const block of blocks) {
    for (const match of block[0].matchAll(TAG)) {
      const attrs: Record<string, string> = {};
      for (const p of match[2]!.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[p[1]!] = (p[2] ?? p[3])!;
      yield { name: match[1]!, attrs };
    }
  }
}

export const bodyComponentTags = (body: string) => componentTags(visibleBody(body));

export function bodyReferences(body: string): Source[] {
  const text = visibleBody(body);
  const out: Source[] = [];
  for (const { name, attrs: a } of componentTags(text)) {
    if (name === 'Compare') {
      if (!a.a || !a.b) continue;
      for (const k of ['a', 'b', 'shots']) if (a[k]) out.push({ src: a[k]!, types: ARRANGED });
    } else if (a.src) {
      out.push({ src: a.src, types: name === 'Storyboard' ? STORYBOARD : name === 'Studio' ? STUDIO : name === 'Asset' ? ASSET : [] });
      if (a.variants) {
        try {
          const v: unknown = JSON.parse(a.variants);
          if (isObject(v)) for (const src of Object.values(v)) if (typeof src === 'string' && src) out.push({ src, types: name === 'Asset' ? ASSET : [] });
        } catch { /* 无效 variants 沿用普通 src。 */ }
      }
    }
  }
  for (const m of text.replace(TAG, '').matchAll(/\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^]*?["'])?\s*\)/g)) out.push({ src: m[1]!, types: [] });
  return out;
}
export const bodySources = (body: string): string[] => [...new Set(bodyReferences(body).map(r => r.src))];

export const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
  '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.mdx': 'text/markdown', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.json': 'application/json', '.txt': 'text/plain',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.css': 'text/css',
  '.tmx': 'application/xml', '.tmj': 'application/json', '.tsj': 'application/json',
};
export type Kind = 'html' | 'markdown' | 'image' | 'video' | 'asset' | 'storyboard' | 'compare' | 'studio' | 'tiled' | 'spritesheet';
export function kindOf(ext: string): Kind {
  const type = TYPES[ext] ?? '';
  if (ext === '.tsx' || type === 'text/html') return 'html';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.tmx' || ext === '.tmj' || ext === '.tsj') return 'tiled';
  if (type.startsWith('image/')) return 'image';
  return type.startsWith('video/') || type.startsWith('audio/') ? 'video' : 'asset';
}
