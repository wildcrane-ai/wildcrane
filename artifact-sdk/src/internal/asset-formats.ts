import { OFFICE_TYPES, officeExtension } from './document';
import { kindOf, spriteSheet, TILED_MAPS, TILESET_JSON, TSX, TYPES, type Kind } from './references';

const HYPERFRAME = '.hf.html';
const MODELS = { '.glb': 'glb', '.blend': 'blend' } as const;
const WORKBOOKS = ['.xlsx'] as const;
const DELIMITERS = { '.csv': ',', '.tsv': '\t' } as const;
export const isHyperframe = (name: string) => name.endsWith(HYPERFRAME);

const extensionOf = (name: string) => /\.[\w-]+$/.exec(name)?.[0].toLowerCase();
export const isTileset = (name: string) => {
  const ext = extensionOf(name);
  return ext === TSX || ext === TILESET_JSON;
};
export const documentExtension = (name: string) => extensionOf(name) === '.pdf' ? '.pdf' : officeExtension(name);
export function modelOf(name: string) {
  const format = MODELS[extensionOf(name) as keyof typeof MODELS];
  return format ? { name, format } : undefined;
}
export const workbookExtension = (name: string) => WORKBOOKS.find(ext => ext === extensionOf(name));
export function delimitedOf(name: string) {
  const ext = extensionOf(name) as keyof typeof DELIMITERS;
  const delimiter = DELIMITERS[ext];
  return delimiter ? { name, delimiter } : undefined;
}

export const TEXT_LIMIT = 1024 * 1024;

const LANGS: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", py: "python", go: "go",
  sh: "bash", bash: "bash", zsh: "bash", sql: "sql", css: "css", scss: "css",
  xml: "xml", svg: "xml", diff: "diff", patch: "diff", mmd: "mermaid", mermaid: "mermaid",
};
const PLAIN = new Set(["txt", "text", "log", "csv", "tsv", "toml", "ini", "env", "rs", "java", "kt", "swift", "rb", "php", "c", "h", "cpp", "hpp", "cs", "lua", "vue", "svelte", "graphql", "prisma", "dockerfile", "gitignore"]);

/** The language a text file is coloured as, "" for plain text, or null for a file that is not text. */
export function textLang(src: string, name: string, type = ""): string | null {
  for (const path of [src, name]) {
    const ext = /\.([\w-]+)$/.exec(path.split("/").pop()!)?.[1]?.toLowerCase();
    if (ext && ext in LANGS) return LANGS[ext]!;
    if (ext && PLAIN.has(ext)) return "";
  }
  return /^text\/|[/+](?:json|yaml|xml)\b/.test(type) ? "" : null;
}

const ofKind = (kind: Kind) => Object.keys(TYPES).filter(ext => kindOf(ext) === kind).join(' ');
const ofLanguage = (lang: string) => Object.keys(LANGS).filter(ext => LANGS[ext] === lang).map(ext => `.${ext}`).join(' ');

export function assetCapabilities(): [label: string, formats: string][] {
  return [
    ['Images', ofKind('image')],
    ['Media', `${ofKind('video')} (browser support varies)`],
    ['Web', `${ofKind('html')} · HyperFrames ${HYPERFRAME} · ${TSX} (Runner builds)`],
    ['Markdown', ofKind('markdown')],
    ['Documents', `.pdf · ${Object.keys(OFFICE_TYPES).join(' ')} (LibreOffice on Runner)`],
    ['Tables', `${WORKBOOKS.join(' ')} · ${Object.keys(DELIMITERS).join(' ')} (UTF-8 or BOM-marked UTF-16)`],
    ['Diagrams', ofLanguage('mermaid')],
    ['Maps', `${Object.keys(TILED_MAPS).join(' ')} + tilesets and images`],
    ['Sprites', spriteSheet.formats],
    ['Diffs', ofLanguage('diff')],
    ['3D models', `${Object.keys(MODELS).join(' ')} (WebGL; self-contained GLB, saved Blender meshes)`],
    ['Text/code', '.txt .json .yaml .xml and other text and source files'],
  ];
}
