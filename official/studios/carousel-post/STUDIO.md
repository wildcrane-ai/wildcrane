---
name: Social post
names:
  zh: 社媒帖
description: Write and revise social posts, with images and carousel pages when needed.
needsArtifact: true
icon: social-post
previews:
  post-draft:
    icon: carousel-outline
    title:
      en: Post draft
      zh: 帖子草稿
  post-images:
    icon: social-image
    title:
      en: Images
      zh: 配图
  post-output:
    icon: carousel
    title:
      en: Post output
      zh: 帖子成稿
---

Write social posts from the task's brief and supplied sources, using only the Previews
needed for this request. Follow the task's saved review plan; Preview IDs describe outputs,
not an approval sequence. Get approval before costly generation when the plan requires it.

- **Evidence**: use project materials and explicit user rules; ask only for missing facts or
  material choices they own, and never invent claims.
- **Format**: default to text-only unless a carousel is requested or the chosen platform
  requires visual content; propose a fitting format from supplied templates when available.
- **Revision**: reuse saved copy, suitable assets and render sources; update only affected
  outputs, and do not generate images for a copy-only edit.
- **Delivery**: keep requested files and reproducible sources in the task's asset folder;
  deliver without publishing or maintaining cross-task memory unless explicitly requested.

<Preview id="post-draft">

Write a brief covering platform, audience, goal, language and format, followed by the exact
post copy. For a carousel, include page count and one section per page with its copy,
layout and any image slots; the opening earns the swipe and each page has one message.
Do not add image slots or extra formats merely to fill the output catalogue.

</Preview>

<Preview id="post-images">

Show only the images this request needs; a text-only post needs no illustration by default.
Reuse suitable supplied or saved assets, and create an image only for a missing or changed
slot. Prefer real screenshots for product interfaces, HTML/CSS or SVG for diagrams, and
image generation for other visuals. Use available skills and tools as needed.

- **Generation**: when needed, use `akb image --aspect <ratio> --tier <tier> --out <file>
  "<prompt>"`; it spends Pro credits, so state the tier and cost choice before generation.
  Default to premium for a lead image, standard for other images and economy for drafts,
  unless the user requests a different quality or budget.
- **Quality**: fit the slot or feed aspect, keep palette, typography and treatment consistent,
  and inspect full-size and feed-thumbnail views before delivery.
- **Files**: save images with their available sources beside them; show each as an Asset with
  its page or paragraph and purpose, using a Set for three or more images.

</Preview>

<Preview id="post-output">

Finish the requested post from `post-draft`, using `post-images` where needed. Write the
requested platform captions (title where needed, body and hashtags) in the post's language.
Render carousel pages only when requested; captions alone require no pages.

- **Source**: lay out pages in HTML/CSS, never generate a whole page as an image; keep one
  adaptive source per page and crop slot images in CSS.
- **Size**: render only required ratios: Xiaohongshu 3:4 at 1080×1440, Instagram and LinkedIn
  4:5 at 1080×1350; confirm an appropriate size for other platforms. Change the viewport to
  render ratios from the same source.
- **Quality**: keep the format's grid, margins and type scale; check every page at full size
  and thumbnail size for overflow, collisions and legibility. Shortening copy changes content
  and must follow the task's review plan.
- **Preview**: save `page-<ratio>-<nn>.png` and one `pages-<ratio>.json` per required ratio,
  using `3x4` or `4x5` in names. Follow the [schema](references/carousel-renderer/references/slides.schema.json)
  and [example](references/carousel-renderer/references/slides.example.json): stable slide IDs,
  page order, each PNG as its preview, and no speaker notes. Validate with
  [the validator](references/carousel-renderer/scripts/validate-storyboard.mjs), then show
  one Storyboard per ratio using `.assets/<card id>/pages-<ratio>.json`.
- **Handoff**: include the asset folder and exact re-render command with the delivered sources;
  on revision, render only affected pages and ratios and retain unchanged media.

</Preview>
