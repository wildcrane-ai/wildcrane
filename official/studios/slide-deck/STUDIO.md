---
name: Slide deck
names:
  zh: 演示文稿
description: Creates or revises wireframes, slide samples, finished slides or an
  image-based PowerPoint, as requested.
summaries:
  zh: 先确认版式，再导出 PowerPoint。
  en: Approve the layout, then export to PowerPoint.
needsArtifact: true
icon: deck
previews:
  deck-draft:
    icon: wireframe
    title:
      en: Wireframes & samples
      zh: 线框稿与样张
    description:
      en: Approve slide structure and sample visual pages.
      zh: 确认页面结构与代表性样张的视觉风格。
  slides:
    icon: slides
    title:
      en: Slides
      zh: 演示文稿
    description:
      en: Review the finished slides or exported PowerPoint.
      zh: 审阅完整演示文稿或导出的 PowerPoint。
---

Create or revise the requested slide work, reusing the project's applicable template and
brand.

- **Evidence first**: settle the audience, goal, setting, slide count, aspect ratio, language
  and visual recipe from the task, project and earlier decks.
- **Review**: for a new full deck, recommend wireframes and three representative samples
  before producing all slides; follow the task's agreed review plan.
- **Resources**: follow [page and narrative rules](shared/RULES.md); use the
  [slide schema](shared/references/slides.schema.json),
  [example](shared/references/slides.example.json) and
  [validator](shared/scripts/validate-storyboard.mjs) for Storyboards.
- **Changes**: preserve existing slide IDs, content, notes and assets outside the requested
  change; update affected pages and previews without remaking unrelated media or exports.

## Land

Deliver the requested slide outputs from the task's asset folder. For finished slides, check the
Storyboard and retain its render project. For PowerPoint, check slide order, one image per slide,
aspect ratio and speaker notes, then record the output path and reproducible rebuild command.

## Previews

<Preview id="deck-draft">

Show the wireframes or final-look samples the task requests.

- **Wireframes**: black text on white in one font; images, screenshots and charts are boxes
  labelled with their content; each slide has a sticky note on its layout and how to make its assets.
- **Samples**: use representative layouts in the final visual recipe; reuse existing samples
  when they still apply.
- **Preview**: write wireframes to `storyboard.json` and samples to `samples.json` in the
  card's asset folder, showing only the requested results in the built-in Storyboard.

  `<Storyboard src="asset:storyboard.json" label="<wireframes>" />`

  `<Storyboard src="asset:samples.json" label="<samples>" />`

- **Acceptance**: validate each Storyboard, then confirm it pages through, zooms and shows
  each slide's notes on the card; fix a failing preview in place.

</Preview>

<Preview id="slides">

Produce or revise the requested finished slides or PowerPoint using the established visual
recipe and any applicable approved wireframes and samples from Preview `deck-draft`.

- **Slides**: keep the render project in `deck/` in the card's asset folder, with pinned
  dependencies and no machine paths; show the finished `storyboard.json` in the built-in
  Storyboard and check each slide against its layout note and visual recipe.

  `<Storyboard src="asset:storyboard.json" />`

- **PowerPoint**: export only when the task requests it; render affected pages to
  `slides/<slide id>.png` at `size` and pack the complete deck with the Studio's
  [PowerPoint packer](references/deck-builder/scripts/pack-pptx.mjs) into `<short-name>.pptx`,
  using a lowercase slug of the card title. Never use a PowerPoint-generation library.
- **Existing images**: a task with approved image previews packs those images as they are;
  refresh any affected cached `slides/<slide id>.png` before packing.
- **Export preview**: show the requested PowerPoint as an Asset beside the slide preview.

  `<Asset src="asset:<short-name>.pptx" label="<card title>" />`

</Preview>
