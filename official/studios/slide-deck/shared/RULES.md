## Memory

The studio's memory is `docs/kanban/memory/studios/slide-deck/feedback.md`: one line per user
correction or preference that changes the next deck, stated as what to do or avoid (see "What
earns a note" in `akb guide board`). The current card wins. Merge duplicates and rewrite
overturned lines in place.

## The source

- **Narrative**: the deck reads as one argument, one message per slide with short copy; put
  each slide's speaker notes in `notes`.
- **Structure**: `storyboard.json` follows `shared/references/slides.schema.json` and
  its example and is the only outline; keep slide IDs stable and set the canvas with `size`.
- **Check**: run `akb raw validate <card id> --json` and the studio's
  `shared/scripts/validate-storyboard.mjs` on every outline you write; fix every diagnostic.

## Pages

- **Pages**: write each slide as `pages/<slide id>.html` or `.tsx`, laid out at `size` and
  referenced by `preview`; pages are the only source of text and look, never copied elsewhere.
- **Assets**: load fonts and images from the asset folder, never from system fonts or the
  network, so the preview and the export match.
- **Consistency**: slides of one type share a stylesheet or component, with the same layout,
  margins and type sizes.
- **Fit**: check every page in a browser at `size` for overflow and collisions; a fix that
  needs shorter copy is a content change.
