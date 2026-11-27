// Card tags, file types and references. This module runs in Node and the browser.
import { markdownDestinations } from './markdown-destinations.ts';

export const previewComponents = {
  asset: { name: 'Asset' },
  compare: { name: 'Compare', summary: 'Compare two Assets' },
  storyboard: { name: 'Storyboard', summary: 'Shot or slide JSON + referenced files' },
  set: { name: 'Set', summary: 'Group related Assets' },
  studio: { name: 'Studio', summary: 'Studio review JSON (akb studio preview)' },
} as const;

export const previewComponentNames = Object.values(previewComponents).map(component => component.name);
export type PreviewComponent = typeof previewComponentNames[number];

const { asset, compare, storyboard, set, studio } = previewComponents;
const sourceTags = [...previewComponentNames.filter(name => name !== set.name), 'Mockup'].join('|');

/** A file the card body names, with the types a JSON file there may be. */
export type Source = { src: string; types: string[] };

export const spriteSheet = { kind: 'spritesheet', formats: 'TexturePacker JSON + sheet image' } as const;

const STORYBOARD = ['storyboard'];
const STUDIO = ['studio'];
// 排列里的 JSON：Asset 能画的类型，或需要拒绝嵌套的分镜与对比。
const ARRANGED = ['storyboard', 'compare', spriteSheet.kind, 'studio'];
// Any other JSON stays a plain file.
const ASSET = [spriteSheet.kind, 'asset'];
export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export type Variant = { label: string; src: string };

/** `variants` as written: two or more, `src` among them — anything else is no variants. */
export function variantsOf(raw: string | undefined, src: string): Variant[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isObject(parsed)) return [];
  const list = Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1]);
  if (list.length < 2 || !list.some(([, s]) => s === src)) return [];
  return list.map(([label, s]) => ({ label, src: s }));
}

export type Captions = string | Record<string, string>;

export function captionsPath(captions: Captions | undefined, label: string | null): string | undefined {
  if (typeof captions === 'string') return captions;
  if (captions && label !== null && Object.hasOwn(captions, label)) return captions[label];
}

function isCaptionPath(value: unknown): value is string {
  return typeof value === 'string' && (value.startsWith('asset:') || !/^(?:[a-z][\w+.-]*:|\s|[/\\])/i.test(value)) && !/[?#\\]/.test(value) && /\.(?:srt|vtt)$/i.test(value);
}

export function parseCaptions(raw: string | undefined, variants: Variant[]): Captions | undefined {
  if (!raw) return;
  if (!variants.length) return isCaptionPath(raw) ? raw : undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value) || Object.keys(value).length !== variants.length) return;
    const labels = variants.map(({ label }) => label);
    if (labels.every(label => Object.hasOwn(value, label) && isCaptionPath(value[label]))) {
      return Object.fromEntries(labels.map(label => [label, value[label] as string]));
    }
  } catch { /* Invalid pairing leaves the media playable. */ }
}

export type Overlay = string | Record<string, string>;

function isOverlayPath(value: unknown): value is string {
  return typeof value === 'string' && (value.startsWith('asset:') || !/^(?:[a-z][\w+.-]*:|[/\\#])/i.test(value)) && /\.html?(?:[?#].*)?$/i.test(value);
}

export function parseOverlay(raw: string | undefined): Overlay | undefined {
  if (!raw) return;
  if (!raw.trimStart().startsWith('{')) return isOverlayPath(raw) ? raw : undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => isOverlayPath(entry[1])));
    }
  } catch { /* An invalid optional overlay leaves the video playable. */ }
}

export function overlayPath(overlay: Overlay | undefined, label: string | null) {
  if (typeof overlay === 'string') return overlay;
  if (overlay && label !== null && Object.hasOwn(overlay, label)) return overlay[label];
}

function visibleBody(body: string): string {
  const newlines = (text: string) => text.replace(/[^\n]/g, '');
  const lines = body.replace(/<!--[^]*?-->/g, newlines).split(/\r?\n/);
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
    if (kept && TAG_START.test(line)) inTag = true;
    if (line.includes('/>')) inTag = false;
  }
  return visible.join('\n').replace(/(`+)[^]*?\1/g, newlines);
}

const TAG = new RegExp(`<(${sourceTags})\\b([^<>]*?)\\/>`, 'g');
const TAG_START = new RegExp(`^ {0,3}<(?:${sourceTags})\\b`);
const TAG_BLOCK = new RegExp(`^ {0,3}(?:<(?:${sourceTags})\\b[^<>]*?\\/>[ \t]*(?:\n[ \t]*)?)+$`, 'gm');

function* componentTags(text: string) {
  const blocks = text.matchAll(TAG_BLOCK);
  for (const block of blocks) {
    for (const match of block[0].matchAll(TAG)) {
      const attrs: Record<string, string> = {};
      for (const p of match[2]!.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[p[1]!] = (p[2] ?? p[3])!;
      yield { name: match[1]!, attrs, offset: block.index + match.index };
    }
  }
}

export const bodyComponentTags = (body: string) => componentTags(visibleBody(body));

export function bodyReferences(body: string, located?: (src: string, line: number) => void): Source[] {
  const text = visibleBody(body);
  const out: Source[] = [];
  const add = (src: string, types: string[], offset: number) => {
    out.push({ src, types });
    located?.(src, text.slice(0, offset).split('\n').length);
  };
  for (const { name, attrs: a, offset } of componentTags(text)) {
    if (name === compare.name) {
      if (!a.a || !a.b) continue;
      for (const k of ['a', 'b', 'shots']) if (a[k]) add(a[k]!, ARRANGED, offset);
    } else if (a.src) {
      add(a.src, name === storyboard.name ? STORYBOARD : name === studio.name ? STUDIO : name === asset.name ? ASSET : [], offset);
      if (a.variants) {
        try {
          const v: unknown = JSON.parse(a.variants);
          if (isObject(v)) for (const src of Object.values(v)) if (typeof src === 'string' && src) add(src, name === asset.name ? ASSET : [], offset);
        } catch { /* 无效 variants 沿用普通 src。 */ }
      }
      if (name === asset.name || name === 'Mockup') {
        const overlay = parseOverlay(a.overlay);
        if (typeof overlay === 'string') add(overlay, [], offset);
        else if (overlay) for (const src of Object.values(overlay)) add(src, [], offset);
        const captions = parseCaptions(a.captions, variantsOf(a.variants, a.src));
        if (typeof captions === 'string') add(captions, ['asset'], offset);
        else if (captions) for (const src of Object.values(captions)) add(src, ['asset'], offset);
      }
    }
  }
  for (const { src, offset } of markdownDestinations(text.replace(TAG, tag => tag.replace(/[^\n]/g, ' ')))) add(src, [], offset);
  return out;
}
export const bodySources = (body: string): string[] => [...new Set(bodyReferences(body).map(r => r.src))];

export const TSX = '.tsx';
export const GLB = 'model/gltf-binary';
export const TILED_MAPS = { '.tmx': 'application/xml', '.tmj': 'application/json' };
export const TILESET_JSON = '.tsj';

export const TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.pdf': 'application/pdf',
  '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.mdx': 'text/markdown',
  '.json': 'application/json', '.txt': 'text/plain', '.srt': 'application/x-subrip', '.vtt': 'text/vtt',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.css': 'text/css',
  '.glb': GLB,
  ...TILED_MAPS, [TILESET_JSON]: 'application/json',
};
export type Kind = 'html' | 'markdown' | 'image' | 'video' | 'asset' | 'storyboard' | 'compare' | 'studio' | 'tiled' | 'spritesheet';
export function kindOf(ext: string): Kind {
  const type = TYPES[ext] ?? '';
  if (ext === TSX || type === 'text/html') return 'html';
  if (type === 'text/markdown') return 'markdown';
  if (Object.hasOwn(TILED_MAPS, ext) || ext === TILESET_JSON) return 'tiled';
  if (type.startsWith('image/')) return 'image';
  return type.startsWith('video/') || type.startsWith('audio/') ? 'video' : 'asset';
}
