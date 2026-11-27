---
name: ui-mockup
description: Create a screen mockup from existing product source for a new or changed screen in that product.
---

# UI mockup

## Build

- **Copy the source**: Copy the real screen components, imported files and global stylesheet into the task's Asset folder. Keep supporting filenames, import the stylesheet from the entry, and rewrite aliases and external paths to local relative imports.
- **Preserve the design**: Change only the requested areas. Keep the product theme and surrounding context, share the copied frame across states, and make changed layouts, controls and copy implementation-ready. Render terminal output as monospaced text.
- **Freeze the state**: Remove fetching, server actions, file and board reads, storage, timers, hooks, `"use client"` and interaction handlers. Use fixed sample data for the state shown.
- **Use a TSX entry**: Default-export the screen from a lowercase, dash-separated `.tsx` file. Convert Vue, Svelte or HTML to TSX and plain CSS, preserving markup and classes.
- **Render offline**: The renderer supports React without hooks, `react-icons/{fi,fa,si}`, `next/{link,image,navigation}`, `clsx`, `tailwind-merge` and `class-variance-authority`. Copy or remove other dependencies. Keep network access and `node:` imports out. Use CSS animation and add one inline `<script dangerouslySetInnerHTML>` only if the requested motion requires it.

## Check and submit

- **Check**: Run the bundled `scripts/check-mockup.mjs` with Node on all entries. If the skill is served by AKB, save it with `akb studio file <current-studio> skills/ui-mockup/scripts/check-mockup.mjs > check-mockup.mjs` and run `node check-mockup.mjs <entry> [<entry> ...]`. Fix failures before submitting.
- **Show**: In the Preview that uses this skill, put each screen's Asset on its own line with its `asset:<entry>.tsx` path, a short label in the board's language, and device `desktop` (1280×800) or `mobile` (393×852). Use the same label for both device views and group three or more screens of one purpose in a Set.
- **Phone frame**: Leave the status bar, safe-area insets and home indicator to the board.
