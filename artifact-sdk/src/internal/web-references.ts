type Destination = { start: number; end: number; src: string };
type CssDestination = Destination & { importToken?: [number, number] };

const SPACE = /[\t\n\f\r ]/;
const HTML_ENTITY = /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi;
const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

function htmlValue(text: string): string {
  return text.replace(HTML_ENTITY, decodeEntity);
}

function decodeEntity(entity: string, key: string): string {
  if (!key.startsWith('#')) return ENTITIES[key] ?? entity;
  const hex = key[1]?.toLowerCase() === 'x';
  const code = parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
}

// A srcset URL ends at whitespace, even when it contains commas. Trailing commas end a candidate.
function* srcset(text: string): Generator<Destination> {
  for (let at = 0; at < text.length;) {
    while (at < text.length && (SPACE.test(text[at]!) || text[at] === ',')) at++;
    const start = at;
    while (at < text.length && !SPACE.test(text[at]!)) at++;
    let end = at;
    while (end > start && text[end - 1] === ',') end--;
    if (end > start) yield { start, end, src: text.slice(start, end) };
    if (end !== at) continue;
    let depth = 0;
    while (at < text.length) {
      const c = text[at++];
      if (c === ',' && depth === 0) break;
      if (c === '(') depth++;
      if (c === ')' && depth) depth--;
    }
  }
}

const CSS_COMMENT = String.raw`\/\*[\s\S]*?(?:\*\/|$)`;
const CSS_ESCAPE = String.raw`\\(?:[\da-f]{1,6}(?:\r\n|[\t\n\f\r ])?|[\s\S])`;
const CSS_STRING = String.raw`"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'`;
const CSS_TOKEN = new RegExp(
  String.raw`${CSS_COMMENT}|url\(\s*(${CSS_STRING}|(?:${CSS_ESCAPE}|[^()"'\s\\])*)\s*\)|(${CSS_STRING})|(@[\w-]+)\b|([\w-]+)\(|([(){};])|[^\s]`,
  'gid',
);

function cssValue(text: string): string {
  return text.replace(/\\(?:([\da-f]{1,6})(?:\r\n|[\t\n\f\r ])?|(\r\n|[\s\S]))/gi, (_, hex, char) => {
    if (!hex) return /^[\r\n\f]/.test(char) ? '' : char;
    const code = parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
  });
}

export function* cssDestinations(css: string): Generator<CssDestination> {
  const functions: string[] = [];
  let isImport = false;
  for (const token of css.matchAll(CSS_TOKEN)) {
    if (token[0].startsWith('/*')) continue;
    const span = token.indices?.[1] ?? token.indices?.[2];
    const imageSet = /^(?:-webkit-)?image-set$/i.test(functions.at(-1) ?? '');
    if (span && (token[1] !== undefined || isImport || imageSet)) {
      const quoted = css[span[0]] === '"' || css[span[0]] === "'";
      const start = span[0] + Number(quoted);
      const end = span[1] - Number(quoted);
      yield { start, end, src: cssValue(css.slice(start, end)), ...(isImport ? { importToken: token.indices![0] } : {}) };
    }
    isImport = token[3]?.toLowerCase() === '@import';
    if (token[4] || token[5] === '(') functions.push(token[4] ?? '');
    if (token[5] === ')') functions.pop();
  }
}

function* shifted(destinations: Iterable<Destination>, offset: number): Generator<Destination> {
  for (const { start, end, src } of destinations) yield { start: start + offset, end: end + offset, src };
}

// Parse the browser's decoded attribute value while retaining offsets into the source.
function* attributeDestinations(value: string, offset: number, parse: (value: string) => Iterable<Destination>): Generator<Destination> {
  const entities = [...value.matchAll(HTML_ENTITY)];
  if (!entities.length) {
    yield* shifted(parse(value), offset);
    return;
  }
  const offsets: number[] = [];
  let decoded = '';
  let at = 0;
  for (const entity of entities) {
    while (at < entity.index) {
      offsets.push(at);
      decoded += value[at++];
    }
    const replacement = decodeEntity(entity[0], entity[1]!);
    for (const unit of replacement.split('')) {
      offsets.push(at);
      decoded += unit;
    }
    at += entity[0].length;
  }
  while (at < value.length) {
    offsets.push(at);
    decoded += value[at++];
  }
  offsets.push(at);
  for (const { start, end, src } of parse(decoded)) yield { start: offset + offsets[start]!, end: offset + offsets[end]!, src };
}

const TAG = /<!--[\s\S]*?(?:-->|$)|<([a-z][\w:-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^"'<>])*)>/gi;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gd;
const RAW = /^(?:script|style|textarea|title|xmp|iframe|noembed|noframes)$/;
const LINK_RESOURCE = /(?:^|\s)(?:stylesheet|(?:module)?preload|prefetch|icon|apple-touch-icon|mask-icon|manifest)(?:\s|$)/i;

export function* htmlDestinations(html: string): Generator<Destination> {
  const tags = new RegExp(TAG);
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    if (!tag[1]) continue;
    const name = tag[1].toLowerCase();
    const attrs = tag[2]!;
    const offset = tag.index + 1 + name.length;
    const attributes = new Map<string, Destination>();
    for (const attr of attrs.matchAll(ATTR)) {
      const key = attr[1]!.toLowerCase();
      const span = attr.indices?.[2] ?? attr.indices?.[3] ?? attr.indices?.[4];
      if (span && !attributes.has(key)) {
        attributes.set(key, { start: span[0], end: span[1], src: attrs.slice(...span) });
      }
    }
    for (const [key, attr] of attributes) {
      const { start, end, src } = attr;
      if (key === 'srcset' || (name === 'link' && key === 'imagesrcset')) {
        yield* attributeDestinations(src, offset + start, srcset);
      } else if (key === 'style') {
        yield* attributeDestinations(src, offset + start, cssDestinations);
      } else if (key === 'src' || key === 'poster' ||
          (name === 'link' && key === 'href' && LINK_RESOURCE.test(attributes.get('rel')?.src ?? '')) ||
          ((name === 'use' || name === 'image' || name === 'feimage') && (key === 'href' || key === 'xlink:href'))) {
        yield { start: offset + start, end: offset + end, src: htmlValue(src).trim() };
      }
    }
    if (!RAW.test(name)) continue;
    const close = new RegExp(`</${name}\\s*>`, 'gi');
    const start = close.lastIndex = tags.lastIndex;
    const end = close.exec(html)?.index ?? html.length;
    if (name === 'style') yield* shifted(cssDestinations(html.slice(start, end)), start);
    tags.lastIndex = close.lastIndex || html.length;
  }
}
