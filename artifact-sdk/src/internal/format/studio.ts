import { isObject } from '../references';

export type StudioAgent = { agent: string; title: { en: string; zh?: string }; icon?: string | { d: string; f?: string; o?: true; s?: string; w?: number }[] };
export type StudioFile = { path: string; before: string | null; after: string | null; diff?: string };
export type AssetResult = { src: string; label?: string; alt?: string; device?: 'mobile' | 'desktop'; loop?: boolean; variants?: Record<string, string> };
export type StudioResult = { agent: string } & (
  | ({ component: 'Asset' } & AssetResult)
  | { component: 'Set'; label: string; items: AssetResult[] }
  | { component: 'Compare'; a: string; b: string; shots?: string; label?: string; 'a-label'?: string; 'b-label'?: string }
  | { component: 'Storyboard'; src: string; label?: string }
);
export type StudioReview = {
  version: 2;
  base: { id: string; version: number; fingerprint: string } | null;
  fingerprint: string;
  agents: StudioAgent[];
  files: StudioFile[];
  results: StudioResult[];
};
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const source = (v: unknown): v is string => text(v) && !/^(?:[a-z][\w+.-]*:|\/|#)|\\|[\u0000-\u001f]/i.test(v);
const icon = (v: unknown) => v === undefined || typeof v === 'string' || (Array.isArray(v) && v.length > 0 && v.length <= 12 && v.every(p => isObject(p) && text(p.d) && /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/.test(p.d) && ['f','s'].every(k => p[k] === undefined || (typeof p[k] === 'string' && /^[kwcgopsmlry]$/.test(p[k] as string))) && (p.o === undefined || p.o === true) && (p.w === undefined || (typeof p.w === 'number' && p.w > 0 && p.w <= 3))));
const relativePath = (v: unknown): v is string => source(v) && v.split('/').every(p => p && p !== '.' && p !== '..');
const optionalText = (v: Record<string, unknown>, keys: string[]) => keys.every(k => v[k] === undefined || typeof v[k] === 'string');
const asset = (v: unknown): boolean => isObject(v) && source(v.src) && optionalText(v, ['label', 'alt'])
  && (v.alt === undefined || !/[<>]/.test(v.alt as string))
  && (v.device === undefined || v.device === 'desktop' || v.device === 'mobile')
  && (v.loop === undefined || typeof v.loop === 'boolean')
  && (v.variants === undefined || (isObject(v.variants) && Object.values(v.variants).every(source)));

export function resultProblem(value: unknown, agents: Set<string>): string | null {
  if (!Array.isArray(value) || value.length > 500) return '/results';
  for (let i = 0; i < value.length; i++) {
    const r = value[i];
    if (!isObject(r) || !text(r.agent) || !agents.has(r.agent) || !optionalText(r, ['label'])) return `/results/${i}`;
    const valid = r.component === 'Asset' ? asset(r)
      : r.component === 'Set' ? typeof r.label === 'string' && Array.isArray(r.items) && r.items.length > 0 && r.items.length <= 500 && r.items.every(asset)
      : r.component === 'Compare' ? source(r.a) && source(r.b) && (r.shots === undefined || source(r.shots)) && optionalText(r, ['a-label', 'b-label'])
      : r.component === 'Storyboard' && source(r.src);
    if (!valid) return `/results/${i}`;
  }
  return null;
}

/** Semantic checks shared by generation, synchronization and the reader. */
export function reviewProblem(v: unknown): string | null {
  if (!isObject(v) || v.version !== 2) return '/version';
  if (!text(v.fingerprint)) return '/fingerprint';
  if (v.base !== null && !(isObject(v.base) && text(v.base.id) && Number.isInteger(v.base.version) && Number(v.base.version) > 0 && text(v.base.fingerprint))) return '/base';
  if (!Array.isArray(v.agents) || v.agents.length > 500) return '/agents';
  const agents = new Set<string>();
  for (const a of v.agents) {
    if (!isObject(a) || !text(a.agent) || !/^[a-z][a-z0-9-]*$/.test(a.agent) || agents.has(a.agent) || !isObject(a.title) || !text(a.title.en) || !optionalText(a.title, ['zh']) || !icon(a.icon)) return '/agents';
    agents.add(a.agent);
  }
  if (!Array.isArray(v.files) || v.files.length > 1000) return '/files';
  const paths = new Set<string>();
  for (const f of v.files) {
    if (!isObject(f) || !relativePath(f.path) || paths.has(f.path) || !(f.before === null || source(f.before)) || !(f.after === null || source(f.after)) || (f.before === null && f.after === null) || (f.diff !== undefined && !source(f.diff)) || ((f.before === null || f.after === null) && !f.diff)) return '/files';
    if (f.path.startsWith('agents/') && !agents.has(f.path.split('/')[1]!)) return '/files';
    paths.add(f.path);
  }
  return resultProblem(v.results, agents);
}
export const parseReview = (v: unknown): StudioReview | null => reviewProblem(v) ? null : v as StudioReview;
export const isReview = (v: unknown): boolean => isObject(v) && v.version === 2;
