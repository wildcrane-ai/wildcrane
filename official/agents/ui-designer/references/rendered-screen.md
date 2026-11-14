## How to draw a rendered screen

A mockup is a folder of files under `<board-state>/assets/<card id>/`, and it starts as a copy
of the real screen's own source — never a lookalike written from scratch. Copy first, trim
second, and design only what this card changes.

### Design the screen

- **Purpose**: include only information, actions and structure needed by the card requirements,
  actual system capabilities and complete user flow.
- **Use**: design for realistic content volumes and preserve the main flow's context.
- **Reuse**: use existing controls and feedback; show information and entry points once, and
  states only when the system provides their data.
- **Results**: keep result content visible unless the user asks to hide it.

### Build the copy

- **Copy the files**: find the components the screen is really built from and copy them into
  the card's folder, filenames and all, together with every file they import.
- **Point the imports at the copies**: rewrite aliases and any path that leaves the folder to a
  relative path inside it. A mockup reads its own folder and nothing else.
- **Bring the stylesheet**: copy the app's global stylesheet in and import it from the entry
  file — `import "./globals.css"`. It carries the theme, so without it the copy loses the
  product's colours, fonts and spacing.
- **Trim the wiring**: remove data fetching, server actions, file and board reads, storage,
  timers, React hooks, `"use client"`, and anything that answers a click. Put fixed sample data
  where they fed, showing the state this mockup is named for.
- **Keep the look**: preserve copied components, theme and details, with implementation-ready
  layout, controls, copy and visual precision in changed areas from the first version.
- **Design only the change**: write new markup only where the card adds or changes something.
- **Shared frame**: share the copied framework across mockups, simplifying unrelated surroundings
  only where the change's layout and usage context remain clear.

### What the board can run

- **The entry file**: the `.tsx` the `<Asset>` tag names, default-exporting the screen. Name it
  in lowercase ASCII with dashes for the page or state it draws: `board-empty`,
  `card-run-failed`. Supporting copies keep their original names.
- **Available unchanged**: React without hooks, `react-icons/fi`, `react-icons/fa`, `react-icons/si`,
  `next/link`, `next/image`, `next/navigation`, `clsx`, `tailwind-merge`,
  `class-variance-authority`.
- **Nothing else**: no other package, no network, no `node:` module. Whatever is left must be
  copied into the folder as a file or trimmed out.
- **A snapshot, not a link**: the copy is frozen where it was taken. It neither reaches the
  running app nor follows the app when the app changes.
- **Any framework**: a screen from Vue, Svelte or plain HTML is rewritten as `.tsx`, keeping
  its markup and classes, and its stylesheet as plain `.css`.
- **Script**: CSS animation runs. Only when the motion the card changes needs script, such as
  canvas or WebGL, add one inline `<script dangerouslySetInnerHTML>`; it runs offline.

Draw terminals and command output as monospaced text inside the mockup too.

Before submitting either screen stage:

- **Get the checker**: save the output of
  `akb raw file <studio> agents/ui-designer/scripts/check-mockup.mjs` as `check-mockup.mjs`.
- **Check**: run `node check-mockup.mjs <entry> [<entry> ...]` on all delivered mockups,
  fixing failures and rerunning until all pass.
- **Inspect**: check their actual display at the delivered sizes for visual fidelity.

Show each screen with an `<Asset>` tag alone in a paragraph:

```
<Asset src=".assets/<card id>/board-empty.tsx" label="Board, nothing on it" device="desktop" />
```

- **Display**: use the entry file's path as `src` and a short screen name in the board's
  language as `label`; set `device` to `mobile` (393×852) or `desktop` (1280×800).
- **Group**: with three or more screens, use one `<Set>` per purpose; a screen's desktop and
  phone views share a `label`.
- **Phone frame**: the board overlays the iOS status bar and home indicator with safe-area
  insets and status bar style; never draw them.
