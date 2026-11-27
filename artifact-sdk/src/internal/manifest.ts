// 组件清单（wildcrane.component.json）：内置与第三方组件用同一份声明说明内容引用了哪些文件、怎样算有效。
import { cssDestinations, htmlDestinations } from './web-references';
import { isAssetRef } from './task-assets';
import builtins from '../builtin';
import { markdownCodeRanges } from './markdown-code.ts';
import { markdownDestinations, type TextDestination } from './markdown-destinations.ts';
import { schemaProblem } from './schema';
import { isReview, reviewProblem } from './format/studio';

type TextReference = { text: string; list?: string } | { markdown: 'image' } | { web: 'html' | 'css' };

/** Where content names another file. `json`: a `/`-path into JSON content, `*` matching every
 *  item; `text`: a regular expression, matched case-insensitively, whose first group is the
 *  reference, split by `list` when set. `types`: what a JSON file named there may be, first match wins. */
export type Reference = ({ json: string } | TextReference) & { types?: string[] };

export interface Manifest {
  name: string;
  types: string[];
  title?: { en: string; zh: string };
  schema?: unknown;
  references?: Reference[];
  /** Regular expressions, matched case-insensitively, whose matches `text` references skip. */
  skip?: string[];
}

/** A reference found in content: its line for text, its JSON path otherwise. */
export interface Found {
  src: string;
  types: string[];
  text: boolean;
  line?: number;
  at?: string;
}

const BUILTINS = builtins as Manifest[];

export const manifestOf = (type: string): Manifest | undefined => BUILTINS.find(m => m.types.includes(type));

/** The first of `types` whose schema `data` holds; with one type, that type and why it does not. */
export function typeOf(data: unknown, types: string[]): { type: string | null; problem?: string } {
  const problem = (type: string) => type === 'studio' && isReview(data) ? reviewProblem(data) : schemaProblem(manifestOf(type)?.schema, data);
  for (const type of types) if (!problem(type)) return { type };
  if (types.length !== 1) return { type: null };
  return { type: types[0]!, problem: `does not match ${types[0]} at ${problem(types[0]!)}` };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A URL the page loads from elsewhere, or none at all. */
const remote = (src: string) => !src || (!isAssetRef(src) && /^(?:[a-z][\w+.-]*:|\/|#)/i.test(src));

function mapJson(node: unknown, keys: string[], at: string, visit: (src: string, at: string) => string): unknown {
  if (!keys.length) return typeof node === 'string' && node ? visit(node, at) : node;
  const [key, ...rest] = keys as [string, ...string[]];
  if (Array.isArray(node)) {
    if (key === '*') return node.map((x, i) => mapJson(x, rest, `${at}/${i}`, visit));
    const i = Number(key);
    return Number.isInteger(i) && i in node ? node.map((x, j) => (j === i ? mapJson(x, rest, `${at}/${j}`, visit) : x)) : node;
  }
  if (!isObject(node)) return node;
  const out: Record<string, unknown> = { ...node };
  for (const k of key === '*' ? Object.keys(node) : key in node ? [key] : []) out[k] = mapJson(node[k], rest, `${at}/${k}`, visit);
  return out;
}

function* regexDestinations(text: string, pattern: string, inCode?: (offset: number) => boolean): Generator<TextDestination> {
  for (const match of text.matchAll(new RegExp(pattern, 'gid'))) {
    if (inCode?.(match.index)) continue;
    const span = match.indices?.[1];
    if (span) yield { src: match[1]!, start: span[0], end: span[1], offset: span[0] };
  }
}

function mapText(text: string, rule: TextReference, skipped: [number, number][], visit: (src: string, line: number) => string, includeRemote: boolean, markdown: boolean): string {
  const code = markdown ? markdownCodeRanges(text) : undefined;
  let range = code?.next().value;
  const inCode = (offset: number) => {
    while (range && offset >= range[1]) range = code?.next().value;
    return !!range && offset >= range[0];
  };
  const destinations = 'text' in rule ? regexDestinations(text, rule.text, inCode)
    : 'markdown' in rule ? markdownDestinations(text, true, inCode)
    : rule.web === 'html' ? htmlDestinations(text) : cssDestinations(text);
  const list = 'text' in rule ? rule.list : undefined;
  let out = '';
  let last = 0;
  for (const destination of destinations) {
    const { src, start, end } = destination;
    if (skipped.some(([a, b]) => start >= a && start < b)) continue;
    if (remote(src) && !includeRemote && !list) continue;
    const line = text.slice(0, 'offset' in destination && typeof destination.offset === 'number' ? destination.offset : start).split('\n').length;
    const one = (source: string) => (remote(source) && !includeRemote ? source : visit(source, line));
    const value = list
      ? src.split(list).map(part => part.replace(/^(\s*)(\S+)/, (_, space: string, source: string) => space + one(source))).join(list)
      : one(src);
    if (value === src) continue;
    out += text.slice(last, start) + value;
    last = end;
  }
  return out + text.slice(last);
}

/** `content` with each reference `manifest` declares replaced by what `map` returns for it. */
export function mapReferences(manifest: Manifest | undefined, content: unknown, map: (src: string, found: Found) => string, includeRemote = false): unknown {
  const skipped = (text: string) => (manifest?.skip ?? []).flatMap(re => [...text.matchAll(new RegExp(re, 'gi'))].map(m => [m.index, m.index + m[0].length] as [number, number]));
  for (const rule of manifest?.references ?? []) {
    const types = rule.types ?? [];
    if ('json' in rule) {
      if (typeof content !== 'string') content = mapJson(content, rule.json.split('/').filter(Boolean), '', (src, at) => map(src, { src, types, text: false, at: at || '/' }));
    } else if (typeof content === 'string') {
      content = mapText(content, rule, skipped(content), (src, line) => map(src, { src, types, text: true, line }), includeRemote, manifest?.name === 'markdown');
    }
  }
  return content;
}

/** Every reference `manifest` declares in `content`, in order. */
export function referencesOf(manifest: Manifest | undefined, content: unknown, includeRemote = false): Found[] {
  const found: Found[] = [];
  mapReferences(manifest, content, (src, ref) => (found.push(ref), src), includeRemote);
  return found;
}
