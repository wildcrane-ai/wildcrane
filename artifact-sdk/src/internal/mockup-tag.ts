// Asset 与旧 Mockup 标签共用卡片资源清单和延迟加载视图。

import { type Shot } from "./format/compare";
import type { Context as BridgeContext } from "../index";
import type { StoryboardView } from "./storyboard";
import type { SpriteSheet } from "./format/spritesheet";
import type { Device } from "./tags";

export * from "./tags";

/** The canvas each device's screen is laid out on, before it is scaled. */
export const SCREENS: Record<Device, { w: number; h: number }> = {
  desktop: { w: 1280, h: 800 },
  mobile: { w: 393, h: 852 },
};


export type ArticleFile = { text: string; href: string };

/** What one artifact version draws as, once loaded. */
export type Drawn = {
  src: string;
  /** A whole HTML document, for the frame's iframe. */
  doc?: string;
  scripts?: boolean;
  /** A `.hf.html` composition, played rather than laid out on a device. */
  hyperframe?: boolean;
  image?: string;
  media?: { kind: "video" | "audio"; href: string };
  file?: { name: string; load: () => Promise<string> };
  article?: ArticleFile;
  /** A text file, shown as its text: `lang` colours it, `diff` for a `.diff` or `.patch`. */
  code?: { text: string; lang: string; href: string };
  /** The note in its place. */
  error?: string;
};

/** Two sides sharing one player and how its play bar is cut (#1740, #1803). */
export type CompareSides = { a: Drawn; b: Drawn | StoryboardView; shots?: Shot[]; breakdown?: StoryboardView };

/** A compare's sides: one shared player, or two Assets each drawn on its own (#526). */
export type CompareSpec = {
  label: string;
  aLabel: string;
  bLabel: string;
  load: () => Promise<CompareSides | { sides: [MockupView, MockupView] }>;
};

/** A developer's component (#2006), framed on its own origin. `load` fails for any reason the
 *  frame cannot be drawn; `save` is there for those who may save. */
export type ComponentSpec = {
  load: () => Promise<{ url: string; schema: unknown; context: BridgeContext }>;
  save: ((content: unknown) => Promise<{ version: number }>) | null;
  file: { name: string; load: () => Promise<string> };
};

/** A Tiled map (#480) and every file it names, keyed as written there. `problem`: why it is not drawn. */
export type TiledMapFiles = {
  map: string;
  tilesets: Record<string, string>;
  images: Record<string, Blob>;
  problem?: "missing" | "zstd";
};

export type TiledSpec = { file: { name: string; load: () => Promise<string> }; load: () => Promise<TiledMapFiles> };

/** A sprite animation (#481): its frames and sheet image. `problem`: why it does not play. */
export type SpriteFiles = { sheet: SpriteSheet | null; image: Blob | null; name: string; problem?: "missing" | "remote" | "invalid" };

export type SpriteSpec = { file: { name: string; load: () => Promise<string> }; load: () => Promise<SpriteFiles> };

/** What the card page draws for one tag: a preview still to load, or the note saying why not. */
export type MockupView = Drawn & {
  component?: ComponentSpec;
  /** Loaded once it scrolls near (#906). `screen` marks an HTML page, laid out on a device. */
  deferred?: { load: () => Promise<Drawn>; screen: boolean; hyperframe?: boolean };
  storyboard?: () => Promise<StoryboardView>;
  /** A studio diagram's data (#451), checked by the component drawing it. */
  studio?: () => Promise<unknown>;
  compare?: CompareSpec;
  tiled?: TiledSpec;
  sprite?: SpriteSpec;
  /** Its artifact is still being read. */
  loading?: true;
  /** The original file, to download. */
  download?: { name: string; load: () => Promise<string> };
};

/** Every path a body's tags name: variants, `<Compare>` sides and `<Storyboard>`s included. */
export { bodySources } from "./references";
