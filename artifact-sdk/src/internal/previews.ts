import type { Context } from '../index';
import { delimitedOf, documentExtension, isHyperframe, isTileset, modelOf, textLang, TEXT_LIMIT, workbookExtension } from './asset-formats';
import { documentPreviewKey, isDocumentPreview, OFFICE_TYPES, PDF } from './document';
import { fileManifest, fileNameOf, relativeFileReference, splitFileReference } from './file-references';
import { manifestOf, mapReferences, referencesOf, type Manifest } from './manifest';
import { hyperframeDocument } from './hyperframe-document';
import { parseCues } from './format/captions';
import { parseReview } from './format/studio';
import { schemaProblem } from './schema';
import { parseShots, shotsProblem, storyboardShots, type Shot } from './format/compare';
import type { CaptionFile, CompareSides, CompareSpec, ComponentSpec, Drawn, MockupView, SpriteFiles, TiledMapFiles } from './mockup-tag';
import { assetRef, isAssetRef, isLegacyAssetRef, isTaskAssetRef, relativeAssetRef, taskAssetPath } from './task-assets';
import { GLB, spriteSheet } from './references';
import { parseSpriteSheet } from './format/spritesheet';
import { imageSize, parseStoryboard, type StoryboardFrame, type StoryboardFrameView, type StoryboardView } from './storyboard';

export type ArtifactVersion = { version: number; content: unknown; file: { url: string; content_type: string } | null; component?: { name: string; version: string } | null };
export type Artifact = { id: string; type: string; name: string; latest_version: number | null; versions: ArtifactVersion[] };
export type SharedComponent = { schema: unknown; url: string; references?: Manifest['references'] };
export type Shared = { artifacts: Artifact[]; card: { assets: Record<string, { artifact: string; version?: number; error?: string }> } | null };
export type FileCacheKey = { scope: string; artifactId: string; version: number };
export type Services = {
  readFile: (url: string, cacheKey?: FileCacheKey) => Promise<Blob>;
  saveVersion: (id: string, content: unknown) => Promise<{ version: number }>;
  errorCode: (error: unknown) => string;
  locale: Context['locale'];
  copy: { card: { mockup: { missing: (name: string) => string; undrawn: (name: string, why: string) => string; previewFailed: string }; compare: { nested: string }; save: Record<'invalid' | 'tooLarge' | 'closed' | 'refused' | 'offline' | 'failed', string> } };
};

type Ref = { art: Artifact; version: ArtifactVersion };
type PageFile = Blob | { css: string; references: PageReference[] };
type PageReference = [source: string, file: PageFile, fragment: string];

const urls = new WeakMap<Blob, string>();
const urlOf = (blob: Blob) => {
  let url = urls.get(blob);
  if (!url) urls.set(blob, (url = URL.createObjectURL(blob)));
  return url;
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What a component may do on this page: `saved` runs after a save landed; no `component` reader, no component. */
export type Host = {
  component: ((art: Artifact, v: ArtifactVersion) => Promise<SharedComponent>) | null;
  canSave: boolean;
  saved: () => void;
  /** An artifact not yet in hand: still being read, or its read failed. */
  status?: (id: string) => "loading" | "failed" | undefined;
  /** Permission-isolated cache scope for persistent local file caching. */
  cacheScope?: string;
};

export { textLang } from './asset-formats';

const SAVE_LIMIT = 256 * 1024;
export class Previews {
  private byId: Map<string, Artifact>;
  constructor(
    private shared: Shared,
    private host: Host,
    private services: Services,
  ) {
    this.byId = new Map(shared.artifacts.map((a) => [a.id, a]));
  }

  private blobs = new Map<string, Promise<Blob>>();
  private pageFiles = new PageFiles();
  private blobOf(art: Artifact, version: ArtifactVersion): Promise<Blob> {
    const file = version.file!;
    const scope = this.host.cacheScope;
    const key = scope ? JSON.stringify([art.id, version.version]) : file.url;
    let value = this.blobs.get(key);
    if (!value) {
      const cacheKey = scope ? { scope, artifactId: art.id, version: version.version } : undefined;
      value = this.services.readFile(file.url, cacheKey).catch(error => { this.blobs.delete(key); throw error; });
      this.blobs.set(key, value);
    }
    return value;
  }

  private resource(art: Artifact, v: ArtifactVersion) {
    const blob = () => v.file
      ? this.blobOf(art, v).then(value => value.type === v.file!.content_type ? value : value.slice(0, value.size, v.file!.content_type))
      : Promise.resolve(new Blob([JSON.stringify(v.content, null, 2)], { type: 'application/json' }));
    return {
      context: async (): Promise<Context> => {
        const file = v.file ? { data: await (await blob()).arrayBuffer(), contentType: v.file.content_type } : undefined;
        return { artifact: { type: art.type, name: art.name, version: v.version, ...(file ? { file } : { content: v.content }) }, readOnly: !this.host.canSave, locale: this.services.locale, theme: 'light' };
      },
      text: async (field: string) => {
        if (v.file) return (await blob()).text();
        if (isObj(v.content) && typeof v.content[field] === 'string') return v.content[field] as string;
        return typeof v.content === 'string' ? v.content : null;
      },
      json: async () => {
        if (v.file) return JSON.parse(await (await blob()).text()) as unknown;
        return typeof v.content === 'string' ? JSON.parse(v.content) as unknown : v.content;
      },
      blob,
    };
  }

  private textOf(v: ArtifactVersion, field: string) {
    const art = [...this.byId.values()].find(a => a.versions.includes(v))!;
    return this.resource(art, v).text(field);
  }
  private fileOf(art: Artifact, v: ArtifactVersion, name = withExt(isTaskAssetRef(art.name) ? fileNameOf(art.name) : art.name, v.file?.content_type ?? 'application/json')) {
    return { name, load: async () => urlOf(await this.resource(art, v).blob()) };
  }

  protected relative(src: string, owner: string): string {
    if (isAssetRef(src)) return '';
    if (this.byId.has(src) || isLegacyAssetRef(src) || /^[a-z][\w+.-]*:/i.test(src)) return src;
    if (isTaskAssetRef(owner)) {
      const resolved = relativeAssetRef(src, owner);
      if (!resolved) return '';
      if (this.shared.card?.assets[resolved]) return resolved;
      if (isLegacyAssetRef(owner)) return owner.split('/').slice(0, 2).join('/') + '/' + taskAssetPath(resolved);
      return resolved;
    }
    return this.shared.card?.assets[src] ? src : relativeFileReference(src, owner);
  }

  /** The version shown: the one `card.assets` pins, else the latest. */
  private ref(id: string, version?: number): Ref | null {
    const assets = this.shared.card?.assets ?? {};
    const pin = assets[id] ?? Object.values(assets).find(ref => ref.artifact === id);
    const art = this.byId.get(pin?.artifact ?? id);
    const n = version ?? pin?.version ?? art?.latest_version;
    const v = art?.versions.find((x) => x.version === n);
    return art && v ? { art, version: v } : null;
  }

  private pinOfSrc(src: string) {
    const [source] = splitFileReference(src);
    const assets = this.shared.card?.assets;
    if (assets && Object.hasOwn(assets, src)) return assets[src];
    if (!isAssetRef(source)) return undefined;
    const file = taskAssetPath(source);
    return file === null ? undefined : assets?.[assetRef(file)];
  }

  /** The artifact a body path names, through `card.assets`. */
  refOfSrc(src: string): Ref | null {
    const at = this.pinOfSrc(src);
    return at ? this.ref(at.artifact, at.version) : this.ref(src);
  }

  attachmentOfSrc(src: string, image = false) {
    const pin = this.pinOfSrc(src);
    if (!pin || pin.error) return undefined;
    const ref = this.ref(pin.artifact, pin.version);
    if (!ref || (image && !ref.version.file?.content_type.startsWith('image/'))) return undefined;
    return this.fileOf(ref.art, ref.version, fileNameOf(src));
  }

  /** The artifact ids the body reaches, so the rest can be listed after it. */
  referenced(srcs: string[]): Set<string> {
    const ids = new Set<string>();
    const visit = (src: string) => {
      const ref = this.refOfSrc(src);
      if (!ref || ids.has(ref.art.id)) return;
      ids.add(ref.art.id);
      for (const child of innerIds(ref)) visit(this.relative(child, ref.art.name));
    };
    for (const src of srcs) visit(src);
    // 文件形式的分镜无需额外读取就能从同步清单识别其依赖。
    for (const pin of Object.values(this.shared.card?.assets ?? {})) ids.add(pin.artifact);
    return ids;
  }

  unreferenced(srcs: string[]): Artifact[] {
    const used = this.referenced(srcs);
    const inner = new Set(this.shared.artifacts.flatMap((a) => (used.has(a.id) ? [] : innerIdsOf(this.ref(a.id)))));
    return this.shared.artifacts.filter((a) => !isDocumentPreview(a.name) && !used.has(a.id) && !inner.has(a.id));
  }

  missing(src: string, label?: string): MockupView {
    return { src, error: this.services.copy.card.mockup.missing(label || fileNameOf(src)) };
  }

  private absent(id: string | undefined, src: string, label?: string): MockupView {
    const status = id ? this.host.status?.(id) : undefined;
    if (status === "loading") return { src, loading: true };
    if (status === "failed") return { src, error: this.services.copy.card.mockup.previewFailed };
    return this.missing(src, label);
  }

  // One view per path or id, so a re-render never starts a load again.
  private views = new Map<string, MockupView>();
  private once(key: string, make: () => MockupView): MockupView {
    let v = this.views.get(key);
    if (!v) this.views.set(key, (v = make()));
    return v;
  }

  /** What a body path draws as; `as` is the type its tag declares. */
  viewOfSrc(src: string, label?: string, as?: "studio"): MockupView {
    return this.once(`src:${src}:${as ?? ""}`, () => {
      const why = this.pinOfSrc(src)?.error;
      if (why) return { src, error: this.services.copy.card.mockup.undrawn(label || fileNameOf(src), why) };
      const ref = this.refOfSrc(src);
      if (!ref) return this.absent(this.pinOfSrc(src)?.artifact, src, label);
      // Runner 0.6.28 stored a studio diagram as a plain file (#484).
      return this.viewOf(as && ref.art.type === "asset" ? { ...ref, art: { ...ref.art, type: as } } : ref, src);
    });
  }

  private overlays = new Map<string, () => Promise<string | null>>();

  videoOverlayOfSrc(src: string | undefined): (() => Promise<string | null>) | undefined {
    if (!src || this.pinOfSrc(src)?.error) return;
    const ref = this.refOfSrc(src);
    if (ref?.art.type !== 'html') return;
    let load = this.overlays.get(src);
    if (!load) {
      const { art, version } = ref;
      let page: Promise<string | null> | undefined;
      load = () => page ??= (async () => {
        const text = await this.resource(art, version).text('html');
        return text === null ? null : await this.withFiles(text, art, version, true);
      })().catch(() => null);
      this.overlays.set(src, load);
    }
    return load;
  }

  captionsOfSrc(src: string): CaptionFile {
    const pin = this.pinOfSrc(src);
    if (pin?.error) return { src };
    const ref = this.refOfSrc(src);
    if (!ref?.version.file) return pin && this.host.status?.(pin.artifact) === 'loading' ? { src, loading: true } : { src };
    const { art, version } = ref;
    return {
      src,
      download: this.fileOf(art, version, fileNameOf(src)),
      load: () => this.blobOf(art, version).then(blob => blob.text()).then(parseCues).catch(() => []),
    };
  }

  viewOfArtifact(id: string): MockupView {
    return this.once(`id:${id}`, () => {
      const ref = this.ref(id);
      return ref ? this.viewOf(ref, ref.art.name) : this.absent(id, id);
    });
  }

  private viewOf(ref: Ref, src: string): MockupView {
    const view = this.drawOf(ref, src);
    return view.component || view.error !== undefined ? view : { ...view, download: view.document?.file ?? view.delimited?.file ?? view.model?.file ?? this.fileOf(ref.art, ref.version) };
  }

  private drawOf({ art, version: v }: Ref, src: string): MockupView {
    const failed = (): Drawn => ({ src, error: this.services.copy.card.mockup.previewFailed });
    const guard = (load: () => Promise<Drawn>) => () => load().catch(failed);
    if (art.type.startsWith("@")) return { src, component: this.componentOf(art, v) };
    const resource = this.resource(art, v);
    switch (art.type) {
      case "html": {
        const hyperframe = isHyperframe(src) || isHyperframe(art.name);
        return {
          src,
          deferred: {
            screen: !hyperframe,
            hyperframe,
            load: guard(async () => {
              const text = await resource.text("html");
              if (text === null) return failed();
              const doc = await this.withFiles(text, art, v);
              return hyperframe ? { src, doc: hyperframeDocument(doc), hyperframe } : { src, doc, scripts: true };
            }),
          },
        };
      }
      case "image":
      case "video":
        if (!v.file) return this.missing(src, art.name);
        return {
          src,
          deferred: {
            screen: false,
            load: guard(async () => {
              const href = urlOf(await resource.blob());
              if (art.type === "image") return { src, image: href };
              return { src, media: { kind: v.file!.content_type.startsWith("audio/") ? "audio" : "video", href } };
            }),
          },
        };
      case "markdown":
        return {
          src,
          deferred: {
            screen: false,
            load: guard(async () => {
              const text = await resource.text("markdown");
              if (text === null) return failed();
              return { src, article: { text: await this.withImages(text, art, v), href: urlOf(new Blob([text], { type: "text/markdown" })) } };
            }),
          },
        };
      case "storyboard":
        return { src, storyboard: () => this.storyboard(v, src) };
      case "studio": {
        const scoped = (source: string) => {
          const key = this.relative(source, art.name);
          const pins = this.shared.card?.assets ?? {};
          const pin = pins[key] ?? Object.values(pins).find(p => p.artifact === key);
          if (!pin) throw Error(this.services.copy.card.mockup.missing(source));
          if (pin.error) throw Error(pin.error);
          const ref = this.refOfSrc(key);
          if (!ref) throw Error(this.services.copy.card.mockup.missing(source));
          if (ref.art.id === art.id || ref.art.type === "studio") throw Error(`Cyclic Studio reference: ${source}`);
          return { key, ref };
        };
        return { src, studio: async () => {
          const data = await resource.json();
          if (isObj(data) && data.version === 2 && !parseReview(data)) throw Error("Invalid Studio review");
          return data;
        }, studioFiles: {
          text: async source => {
            const { ref } = scoped(source);
            const text = await this.resource(ref.art, ref.version).text("text").catch(error => {
              throw Object.assign(error instanceof Error ? error : Error(String(error)), { retryable: true });
            });
            if (text === null) throw Error(`File unavailable: ${source}`);
            if (new TextEncoder().encode(text).length > 8 * TEXT_LIMIT) throw Error(`File is too large: ${source}`);
            return text;
          },
          ref: source => { try { return scoped(source).ref; } catch { return null; } },
          view: source => {
            try { return this.viewOfSrc(scoped(source).key); }
            catch (e) { return { src: source, error: e instanceof Error ? e.message : String(e) }; }
          },
          compare: tag => ({ ...tag, load: async () => {
            for (const source of [tag.a, tag.b, tag.shots].filter(Boolean)) scoped(source);
            return this.compare(tag, source => this.relative(source, art.name)).load();
          } }),
        } };
      }
      case "tiled":
        // A tileset on its own is a file, not a map.
        if (isTileset(art.name)) return { src, file: this.fileOf(art, v) };
        return { src, tiled: { file: this.fileOf(art, v), load: () => this.tiled(art, v) } };
      case spriteSheet.kind:
        return { src, sprite: { file: this.fileOf(art, v), load: () => this.sprite(art, v) } };
      case "compare":
        return { src, compare: { label: src, aLabel: '', bLabel: '', load: async () => {
          const data = await resource.json();
          if (!isObj(data)) throw new Error(this.services.copy.card.mockup.previewFailed);
          return this.compareOf(data, src).load();
        } } };
      default: {
        const file = v.file;
        const documentName = [art.name, src].find(documentExtension);
        const mime = file?.content_type.split(';')[0]!.trim().toLowerCase();
        if (file && (documentName || mime === PDF || Object.values(OFFICE_TYPES).some(type => type === mime))) {
          const key = documentPreviewKey(art.id, v.version);
          const pin = this.shared.card?.assets[key];
          const native = mime === PDF || documentExtension(documentName ?? '') === ".pdf";
          const pdf = native ? { art, version: v } : pin?.version ? this.refOfSrc(key) : null;
          const name = fileNameOf(documentName ?? withExt(art.name, mime!));
          return { src, document: { file: this.fileOf(art, v, name), load: pdf?.version.file ? () => this.blobOf(pdf.art, pdf.version) : null } };
        }
        const model = modelOf(src) ?? modelOf(art.name);
        if (file && (model || mime === GLB)) {
          const name = fileNameOf(model?.name ?? withExt(art.name, GLB));
          const format = model?.format ?? "glb";
          return { src, model: { file: this.fileOf(art, v, name), format, load: () => this.blobOf(art, v) } };
        }
        if (file && [src, art.name].some(workbookExtension)) {
          return { src, workbook: { file: this.fileOf(art, v), load: () => this.blobOf(art, v) } };
        }
        const delimited = delimitedOf(art.name) ?? delimitedOf(fileNameOf(src));
        if (file && delimited) {
          return { src, delimited: {
            file: this.fileOf(art, v, delimited.name),
            delimiter: delimited.delimiter,
            load: async () => {
              const blob = await this.blobOf(art, v);
              if (blob.size > 3 * TEXT_LIMIT + 3) return { text: null };
              const data = await blob.arrayBuffer();
              const [first, second] = new Uint8Array(data, 0, Math.min(2, data.byteLength));
              const encoding = first === 0xff && second === 0xfe ? "utf-16le"
                : first === 0xfe && second === 0xff ? "utf-16be" : "utf-8";
              try {
                const text = new TextDecoder(encoding, { fatal: true }).decode(data);
                return { text: text.length <= TEXT_LIMIT ? text : null };
              } catch {
                return { error: "encoding" };
              }
            },
          } };
        }
        const lang = textLang(src, art.name, v.file?.content_type);
        if (lang === null) return { src, file: this.fileOf(art, v) };
        return {
          src,
          deferred: {
            screen: false,
            load: guard(async () => {
              const text = (await resource.text("")) ?? JSON.stringify(v.content, null, 2);
              if (text.length > TEXT_LIMIT) return { src, file: this.fileOf(art, v) };
              return { src, code: { text, lang, href: urlOf(new Blob([text], { type: "text/plain" })) } };
            }),
          },
        };
      }
    }
  }

  /** Framed when a component is pinned and still published; the file to download otherwise. */
  private componentOf(art: Artifact, v: ArtifactVersion): ComponentSpec {
    const pin = v.component;
    const { component, canSave, saved } = this.host;
    let schema: unknown = null;
    return {
      file: this.fileOf(art, v),
      load: async () => {
        if (!pin || !component) throw new Error("no component");
        const [meta, context] = await Promise.all([component(art, v), this.resource(art, v).context()]);
        schema = meta.schema;
        const files = this.filesOf({ name: art.name, types: [art.type], references: meta.references }, context.artifact.content, art, v);
        return { url: meta.url, schema, context: files.size ? { ...context, files: await this.contents(files) } : context };
      },
      save: canSave
        ? async (content) => {
            const t = this.services.copy.card.save;
            let text: string | undefined;
            try {
              text = JSON.stringify(content);
            } catch {
              /* unserializable: refused below */
            }
            if (text === undefined) throw new Error(t.invalid);
            if (new TextEncoder().encode(text).length > SAVE_LIMIT) throw new Error(t.tooLarge);
            if (schemaProblem(schema, JSON.parse(text))) throw new Error(t.invalid);
            try {
              const made = await this.services.saveVersion(art.id, JSON.parse(text));
              saved();
              return { version: made.version };
            } catch (e) {
              const code = this.services.errorCode(e);
              throw new Error(
                code === "conflict" ? t.closed
                : code === "owner_only" || code === "not_found" || code === "unauthenticated" ? t.refused
                : code === "payload_too_large" ? t.tooLarge
                : code === "bad_request" ? t.invalid
                : code === "offline" ? t.offline
                : t.failed,
              );
            }
          }
        : null,
    };
  }

  /** A loaded side of the synced player: an image or a video, a storyboard, or the note. */
  private async side(id: string): Promise<Drawn | StoryboardView> {
    const ref = this.ref(id);
    if (!ref) return { src: id, error: this.services.copy.card.mockup.missing(id) };
    const view = this.viewOf(ref, ref.art.name);
    if (view.storyboard) return view.storyboard();
    if (view.deferred) return view.deferred.load();
    return view;
  }

  /** What an arrangement holds at `src`: the view an Asset would draw, or the note refusing nesting. */
  private arranged(src: string, nest: string[]): MockupView {
    const type = this.refOfSrc(src)?.art.type;
    return type && (nest.includes(type) || type === "studio") ? { src, error: this.services.copy.card.compare.nested } : this.viewOfSrc(src);
  }

  private compareOf(c: Record<string, unknown>, src: string): CompareSpec {
    const s = (k: string) => (typeof c[k] === "string" ? (c[k] as string) : "");
    return this.compare({ a: s("a"), b: s("b"), shots: c.shots, label: s("label") || src, aLabel: s("a-label") || s("a_label") || s("aLabel"), bLabel: s("b-label") || s("b_label") || s("bLabel") }, (x) => this.relative(x, src));
  }

  /** A `<Compare>` tag's sides, by body path. */
  compareOfTag(tag: { a: string; b: string; shots: string; label: string; aLabel: string; bLabel: string }): CompareSpec {
    return this.once(`cmp:${JSON.stringify(tag)}`, () => ({ src: tag.a, compare: this.compare(tag, path => path) })).compare!;
  }

  private compare(
    t: { a: string; b: string; shots: unknown; label: string; aLabel: string; bLabel: string },
    idOf: (x: string) => string,
  ): CompareSpec {
    return {
      label: t.label,
      aLabel: t.aLabel,
      bLabel: t.bLabel,
      load: async () => {
        const [ta, tb] = [t.a, t.b].map((x) => this.refOfSrc(idOf(x))?.art.type);
        // Two images, two videos or a video and its storyboard share one player; anything else is two Assets.
        const sides = (): { sides: [MockupView, MockupView] } => ({ sides: [this.arranged(idOf(t.a), ["compare"]), this.arranged(idOf(t.b), ["compare"])] });
        if (!(ta && tb && (ta === tb ? ta === "image" || ta === "video" : ta === "video" && tb === "storyboard"))) return sides();
        const [a, b] = await Promise.all([this.side(idOf(t.a)), this.side(idOf(t.b))]);
        if ("storyboard" in b && b.slides) return sides();
        const out: CompareSides = { a: "storyboard" in a ? { src: t.a, error: this.services.copy.card.mockup.previewFailed } : a, b };
        if (Array.isArray(t.shots)) {
          if (!shotsProblem(t.shots)) out.shots = t.shots as Shot[];
        } else if (typeof t.shots === "string" && t.shots) {
          const ref = this.ref(idOf(t.shots));
          if (ref?.art.type === "storyboard") out.breakdown = await this.storyboard(ref.version, ref.art.name);
          else if (ref) {
            const list = Array.isArray(ref.version.content) ? (shotsProblem(ref.version.content) ? null : (ref.version.content as Shot[])) : parseShots((await this.textOf(ref.version, "shots")) ?? "");
            if (list) out.shots = list;
          }
        }
        if (!out.shots && !out.breakdown && "storyboard" in b && b.shots) out.shots = storyboardShots({ shots: b.shots });
        return out;
      },
    };
  }

  /** A map's text and the tilesets and images it reaches, each named as written where it is used. */
  private async tiled(art: Artifact, v: ArtifactVersion): Promise<TiledMapFiles> {
    const out: TiledMapFiles = { map: (await this.resource(art, v).text("tiled")) ?? "", tilesets: {}, images: {} };
    const zstd = (text: string) => /compression\s*=\s*["']zstd|"compression"\s*:\s*"zstd"/.test(text);
    const read = async (text: string, owner: string): Promise<void> => {
      await Promise.all(referencesOf(manifestOf("tiled"), text).map(async ({ src, types }) => {
        const ref = this.ref(this.relative(src, owner));
        if (!ref?.version.file) { out.problem ??= "missing"; return; }
        const blob = await this.blobOf(ref.art, ref.version);
        if (!types.length) { out.images[src] = blob; return; }
        const tileset = await blob.text();
        out.tilesets[src] = tileset;
        await read(tileset, ref.art.name);
      }));
    };
    await read(out.map, art.name);
    if ([out.map, ...Object.values(out.tilesets)].some(zstd)) out.problem = "zstd";
    return out;
  }

  /** A sheet's frames and its image, found by `meta.image`. */
  private async sprite(art: Artifact, v: ArtifactVersion): Promise<SpriteFiles> {
    const sheet = parseSpriteSheet(await this.resource(art, v).json().catch(() => null));
    if (!sheet) return { sheet: null, image: null, name: "", problem: "invalid" };
    const ref = this.ref(this.relative(sheet.image, art.name));
    const name = fileNameOf(ref?.art.name ?? sheet.image);
    if (ref?.version.file) return { sheet, image: await this.blobOf(ref.art, ref.version), name };
    return { sheet, image: null, name, problem: /^(?:[a-z][\w+.-]*:|\/|#)/i.test(sheet.image) ? "remote" : "missing" };
  }

  protected fileReferences(manifest: Manifest | undefined, content: unknown, _art: Artifact, _version: ArtifactVersion) {
    return referencesOf(manifest, content);
  }

  /** The files `content` names, as its manifest declares, each by the reference written there. */
  private filesOf(manifest: Manifest | undefined, content: unknown, art: Artifact, version: ArtifactVersion): Map<string, Ref> {
    const files = new Map<string, Ref>();
    for (const { src, text } of this.fileReferences(manifest, content, art, version)) {
      const ref = this.ref(this.relative(text ? splitFileReference(src)[0] : src, art.name));
      if (ref?.version.file && !files.has(src)) files.set(src, ref);
    }
    return files;
  }

  private async contents(files: Map<string, Ref>): Promise<Record<string, { data: ArrayBuffer; contentType: string }>> {
    const out: Record<string, { data: ArrayBuffer; contentType: string }> = {};
    await Promise.all([...files].map(async ([src, ref]) => { out[src] = { data: await (await this.blobOf(ref.art, ref.version)).arrayBuffer(), contentType: ref.version.file!.content_type }; }));
    return out;
  }

  private async withFiles(doc: string, art: Artifact, version: ArtifactVersion, localUrls = false): Promise<string> {
    if (!localUrls && typeof window === 'undefined') return doc;

    const pageReference = async (src: string, ref: Ref, parents: ReadonlySet<string>): Promise<PageReference> => {
      const blob = await this.resource(ref.art, ref.version).blob();
      const manifest = fileManifest(ref.art.type, ref.art.name);
      const fragment = src.match(/#.*$/)?.[0] ?? '';
      if (manifest?.name !== 'css') return [src, blob, fragment];

      const text = await blob.text();
      const children = this.filesOf(manifest, text, ref.art, ref.version);
      const visited = new Set([...parents, ref.art.id]);
      const references = await Promise.all(
        [...children].filter(([, child]) => !visited.has(child.art.id))
          .map(([source, child]) => pageReference(source, child, visited)),
      );
      let prefix = '__wildcrane_css_';
      while (text.includes(prefix)) prefix += '_';
      const tokens = new Map(references.map(([source], index) => [source, `${prefix}${index}_`]));
      const css = mapReferences(manifest, text, source => tokens.get(source) ?? source) as string;
      return [src, { css, references: references.map(([source, file, hash]) => [tokens.get(source)!, file, hash]) }, fragment];
    };

    const manifest = manifestOf(art.type);
    const parents = new Set([art.id]);
    const files = [...this.filesOf(manifest, doc, art, version)].filter(([, ref]) => !parents.has(ref.art.id));
    if (!files.length) return doc;
    if (localUrls) {
      const refs = await Promise.all(files.map(([src, ref]) => pageReference(src, ref, parents)));
      const url = (file: PageFile): string => file instanceof Blob ? urlOf(file) : urlOf(new Blob([
        file.references.reduce((css, [token, child, hash]) => css.replaceAll(token, url(child) + hash), file.css),
      ], { type: 'text/css' }));
      const urls = new Map(refs.map(([src, file, hash]) => [src, url(file) + hash]));
      return mapReferences(manifest, doc, src => urls.get(src) ?? src) as string;
    }

    // Request linked files from the sandbox as it draws the page.
    return this.pageFiles.inject(doc, manifest, files.map(([src, ref]) => [src, () => pageReference(src, ref, parents)]));
  }

  /** A document with the pictures it names swapped for blob URLs; one it cannot reach keeps its path. */
  private async withImages(text: string, art: Artifact, version: ArtifactVersion): Promise<string> {
    const manifest = manifestOf(art.type);
    const files = this.filesOf(manifest, text, art, version);
    if (!files.size) return text;
    const urls = new Map<string, string>();
    await Promise.all([...files].map(async ([src, ref]) => { urls.set(src, urlOf(await this.blobOf(ref.art, ref.version))); }));
    return mapReferences(manifest, text, src => urls.get(src) ?? src) as string;
  }

  private async storyboard(v: ArtifactVersion, src: string): Promise<StoryboardView> {
    const art = [...this.byId.values()].find(a => a.versions.includes(v))!;
    const data = await this.resource(art, v).json();
    const parsed = parseStoryboard(data);
    const frame = async (f: StoryboardFrame, slide = false): Promise<StoryboardFrameView> => {
      const ref = this.ref(this.relative(f.src, art.name));
      const none: StoryboardFrameView = { src: f.src, alt: f.alt, href: null, ratio: null };
      if (!ref) return none;
      const file = this.fileOf(ref.art, ref.version);
      if (ref.art.type !== "image" && !(slide && ref.art.type === "html")) return { ...none, view: this.arranged(this.relative(f.src, art.name), ["compare", "storyboard"]) };
      try {
        if (slide && ref.art.type === "html") {
          const text = await this.textOf(ref.version, "html");
          return text === null ? none : { src: f.src, alt: f.alt, href: ref.art.id, ratio: parsed!.size.width / parsed!.size.height, page: true, doc: await this.withFiles(text, ref.art, ref.version), file };
        }
        if (!ref.version.file) return none;
        const blob = await this.resource(ref.art, ref.version).blob();
        const size = imageSize(new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer()));
        return { src: f.src, alt: f.alt, href: urlOf(blob), ratio: size && size.height > 0 ? size.width / size.height : null, file };
      } catch {
        return none;
      }
    };
    const shots = parsed?.shots ? await Promise.all(parsed.shots.map(async (s) => ({ ...s, frames: await Promise.all(s.frames.map((f) => frame(f))) }))) : null;
    const slides = parsed?.slides ? await Promise.all(parsed.slides.map(async (s) => ({ ...s, preview: await frame(s.preview, true) }))) : null;
    const first = [...(slides?.map((s) => s.preview) ?? []), ...(shots?.flatMap((s) => s.frames) ?? [])].find((f) => f.ratio);
    return { src, storyboard: true, ratio: first?.ratio ?? 16 / 9, size: parsed?.size ?? { width: 1920, height: 1080 }, shots, slides };
  }
}

/** The artifact ids a JSON version draws inside itself, as its type's manifest declares. */
function innerIds({ art, version }: Ref): string[] {
  return referencesOf(manifestOf(art.type), version.content).map(ref => ref.src);
}

const innerIdsOf = (ref: Ref | null) => (ref ? innerIds(ref) : []);

type PageLoader = () => Promise<PageReference>;
const pages = new Map<string, WeakRef<readonly PageLoader[]>>();
const pageCleanup = new FinalizationRegistry<string>(token => pages.delete(token));

class PageFiles {
  private loaders: PageLoader[][] = [];

  inject(doc: string, manifest: Manifest | undefined, files: [string, PageLoader][]): string {
    if (!pages.size) window.addEventListener('message', openPageFiles);
    const token = crypto.randomUUID();
    const prefix = `about:blank#akb-${token}-`;
    const loaders = files.map(([, load]) => load);
    this.loaders.push(loaders);
    pages.set(token, new WeakRef(loaders));
    pageCleanup.register(loaders, token);
    const placeholders = new Map(files.map(([src], index) => [src, prefix + index + '_']));
    doc = mapReferences(manifest, doc, src => placeholders.get(src) ?? src) as string;
    const script = `<script>(() => {
      const token = ${JSON.stringify(token)};
      const prefix = ${JSON.stringify(prefix)};
      const channel = new MessageChannel();
      const requested = new Set();
      const targets = new Map();
      const collect = (node, text, apply, lazy, media) => {
        for (const match of text.matchAll(new RegExp(prefix + "([0-9]+)_", "g"))) {
          const id = Number(match[1]);
          if (!targets.has(id)) targets.set(id, []);
          targets.get(id).push(apply);
          if (media) media.add(id);
          if (!lazy) request(id);
          else {
            const ids = lazyNodes.get(node) || new Set();
            ids.add(id);
            lazyNodes.set(node, ids);
            observer.observe(node);
          }
        }
      };
      const request = id => {
        if (requested.has(id)) return;
        requested.add(id);
        channel.port1.postMessage(id);
      };
      const lazyNodes = new WeakMap();
      const observer = new IntersectionObserver(entries => {
        for (const { target, isIntersecting } of entries) {
          if (!isIntersecting) continue;
          observer.unobserve(target);
          lazyNodes.get(target)?.forEach(request);
        }
      }, { rootMargin: "100px" });
      const fileUrl = file => URL.createObjectURL(file instanceof Blob ? file : new Blob([
        file.references.reduce((css, [name, child, hash]) => css.replaceAll(name, fileUrl(child) + hash), file.css)
      ], { type: "text/css" }));
      const mediaSources = new Map();
      channel.port1.onmessage = ({ data: { id, ref } }) => {
        if (!targets.has(id)) return;
        if (ref) {
          const url = fileUrl(ref[1]) + ref[2];
          for (const apply of targets.get(id)) apply(prefix + id + "_", url);
        }
        targets.delete(id);
        for (const [media, pending] of mediaSources) {
          if (!pending.delete(id) || pending.size) continue;
          mediaSources.delete(media);
          if (!media.hasAttribute("src")) media.load();
        }
      };
      const connect = () => {
        for (const node of document.querySelectorAll("*")) {
          const lazyNode = node.matches("source") ? node.closest("picture")?.querySelector("img") : node;
          const lazy = lazyNode?.getAttribute("loading") === "lazy";
          const media = node.matches("audio > source, video > source") ? node.parentElement : null;
          for (const { name, value } of [...node.attributes]) {
            const pending = media && name === "src" ? mediaSources.get(media) ?? new Set() : null;
            collect(lazyNode, value, (from, to) => {
              const current = node.getAttribute(name);
              if (current?.includes(from)) node.setAttribute(name, current.replaceAll(from, to));
            }, lazy, pending);
            if (pending?.size) mediaSources.set(media, pending);
          }
          if (node.tagName === "STYLE") {
            collect(node, node.textContent, (from, to) => {
              if (node.textContent.includes(from)) node.textContent = node.textContent.replaceAll(from, to);
            }, false);
          }
        }
        parent.postMessage({ wildcraneFiles: token }, "*", [channel.port2]);
      };
      document.readyState === "loading" ? addEventListener("DOMContentLoaded", connect, { once: true }) : connect();
    })()</script>`;
    const head = /<head\b[^>]*>/i.exec(doc);
    const at = head ? head.index + head[0].length : 0;
    return doc.slice(0, at) + script + doc.slice(at);
  }
}

function openPageFiles(event: MessageEvent) {
  const token = event.data?.wildcraneFiles;
  const loaders = typeof token === 'string' ? pages.get(token)?.deref() : undefined;
  const port = event.ports[0];
  if (!loaders || !port || event.origin !== 'null') return;
  port.onmessage = ({ data: id }) => {
    if (!Number.isInteger(id) || !loaders[id]) return;
    void loaders[id]!().then(
      ref => port.postMessage({ id, ref }),
      () => port.postMessage({ id, ref: null }),
    );
  };
}

const EXTS: Record<string, string> = {
  "application/json": "json",
  [PDF]: "pdf",
  [OFFICE_TYPES[".docx"]]: "docx",
  [OFFICE_TYPES[".pptx"]]: "pptx",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/html": "html",
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "application/zip": "zip",
  [GLB]: "glb",
};

/** The name with the extension its content type implies, unless it already ends in one. */
function withExt(name: string, contentType: string): string {
  const ext = EXTS[contentType.split(";")[0]!.trim().toLowerCase()];
  if (!ext) return name;
  const has = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const same = has === ext || (ext === "jpeg" && has === "jpg") || (ext === "html" && has === "htm");
  return same ? name : `${name}.${ext}`;
}
