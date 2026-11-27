---
name: landing-page
description: Create a new public-facing landing or promotional page using the project's brand and the Wild Crane template catalog.
---

# Landing page

1. **Gather brand context**: Collect the product name, logo, colors, fonts, selling points, and screenshots from the task and project.
2. **Confirm copy first**: Draft headlines, body copy, and CTAs from verified facts and confirm them with the user before picking a template or rendering.
3. **Pick a template**: Search the catalog (`akb template list-tags --category ui`, `akb template search --category ui --tags website`) and fetch a match into an empty folder (`akb template get <name> --to <dir>`), or design from the brand if none fits.
4. **Strip template colors and adapt**: Audit every media slot (`content/*.json`, `fill/`, including `backdrop` art, textures, gradients, and logos) and theme/CSS color token (canvas, scrim, badges), replacing, recoloring, or removing anything from the template's original palette. Map brand tokens, confirmed copy, and local assets into supported fields, drop unverified sections, and re-confirm only if core product facts change.
5. **Save and present**: Save the HTML and local assets under the card's asset folder. In `<Preview id="ui-design">`, add matching `desktop` and `mobile` Asset tags and list the template's `name`, `revision`, and preview URLs.
6. **Verify and inspect**: Save Coding's checker with `akb studio file coding skills/ui-mockup/scripts/check-mockup.mjs > check-mockup.mjs` and run `node check-mockup.mjs <entry>`. Inspect the `1280×800` and `393×852` layouts for overflow, broken assets, off-brand backdrops, and leftover template demo UI before submitting.
