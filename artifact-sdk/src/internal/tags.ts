// Card body tags as written: `<Asset>` (and the older `<Mockup>`) and `<Set>`. No DOM here.

/** A mockup as a card body points at it. */
export type MockupTag = {
  src: string;
  /** The name on the frame. Empty when the tag carries none. */
  label: string;
  alt: string;
  /** The screen an HTML mockup is laid out on (#1097). Anything but `mobile` is desktop. */
  device: Device;
  /** A bare `loop` (#1595): a video that plays muted, looping and without controls. */
  loop: boolean;
  variants: Variant[];
};

export type Variant = { label: string; src: string };

export type Device = "mobile" | "desktop";

export const deviceOf = (value: string | null | undefined): Device => (value === "mobile" ? "mobile" : "desktop");

// A self-closing tag with no `<` or `>` inside it.
const TAG = /<(?:Asset|Mockup)\b([^<>]*?)\/>/g;
const ATTR = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g;
const LOOP = /(?:^|\s)loop(?=\s|$)/;

/** Every mockup tag in a run of raw HTML, in the order they appear. */
export function mockupTags(raw: string): MockupTag[] {
  const found: MockupTag[] = [];
  for (const match of raw.matchAll(TAG)) {
    const attrs: Record<string, string> = {};
    for (const a of match[1]!.matchAll(ATTR)) {
      attrs[(a[1] ?? a[3])!] = (a[2] ?? a[4])!;
    }
    if (!attrs.src) continue;
    const loop = LOOP.test(match[1]!.replace(ATTR, ""));
    found.push({ src: attrs.src, label: attrs.label ?? "", alt: attrs.alt ?? "", device: deviceOf(attrs.device), loop, variants: variantsOf(attrs.variants, attrs.src) });
  }
  return found;
}

/** `variants` as written: two or more, `src` among them — anything else is no variants. */
export function variantsOf(raw: string | undefined, src: string): Variant[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const list = Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string" && !!e[1]);
  if (list.length < 2 || !list.some(([, s]) => s === src)) return [];
  return list.map(([label, s]) => ({ label, src: s }));
}

/** The tags in a block that holds nothing but tags — `null` when anything else is in there. */
export function mockupBlock(raw: string): MockupTag[] | null {
  const tags = mockupTags(raw);
  if (tags.length === 0) return null;
  return raw.replace(TAG, "").trim() === "" ? tags : null;
}

/** A `<Set label="...">` block: its Asset lines, then `</Set>`, nothing else (#587). */
export type SetTag = { label: string; tags: MockupTag[] };

const SET = /^[ \t]*<Set\b([^<>]*)>[ \t]*\n([^]*?)\n[ \t]*<\/Set>[ \t]*$/;

export function setBlock(raw: string): SetTag | null {
  const m = SET.exec(raw.trim());
  if (!m) return null;
  let label = "";
  for (const a of m[1]!.matchAll(ATTR)) if ((a[1] ?? a[3]) === "label") label = (a[2] ?? a[4])!;
  const tags = mockupBlock(m[2]!);
  return label && tags ? { label, tags } : null;
}

/** One entry of a set: the Assets sharing a label, each a device or a file beside its diff. */
export type SetItem = { label: string; tags: MockupTag[] };

export const isDiff = (src: string) => /\.(?:diff|patch)$/i.test(src);

export function setItems(tags: MockupTag[]): SetItem[] {
  const items = new Map<string, SetItem>();
  for (const tag of tags) {
    const key = tag.label ? `label:${tag.label}` : `src:${tag.src}`;
    const item = items.get(key);
    if (item) item.tags.push(tag);
    else items.set(key, { label: tag.label, tags: [tag] });
  }
  return [...items.values()];
}
