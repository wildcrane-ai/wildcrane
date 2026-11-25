---
name: landing-page
description: Create a new public-facing landing or promotional page using the project's brand and the Wild Crane template catalog.
---

# Landing page

1. Gather the product name, logo, colors, fonts, core selling points, and current product screenshots from the task and project.
2. Use `akb template list-tags --category ui` and `akb template search --category ui --tags website` with relevant tags or topic words to find a fitting template. Fetch one match into an empty folder with `akb template get <name> --to <dir>`. If the catalog is unavailable or has no suitable match, design from the project's brand.
3. Adapt the layout, copy, and assets to the brand. Remove sections that lack relevant, verified content and replace template sample claims with verified product facts.
4. Save the responsive HTML and its local dependencies under the card's asset folder. Put two Asset tags for the page in `<Preview id="ui-design">`, using the same label and the `desktop` (1280×800) and `mobile` (393×852) device values.
5. Save the output of `akb raw file coding scripts/check-mockup.mjs` as `check-mockup.mjs` and run `node check-mockup.mjs <entry>`. Check the layout and copy at both sizes and fix issues before submitting.
