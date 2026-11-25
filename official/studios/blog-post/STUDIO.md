---
name: Blog post
names:
  zh: 博客文章
description: Research, draft and revise blog posts with the images and destination copies the request needs.
summaries:
  zh: 先确认大纲，再写成带配图的文章。
  en: Approve the outline, then get the full article.
needsArtifact: true
icon: blog
previews:
  article-outline:
    icon: outline
    title:
      en: Brief & outline
      zh: 简报与大纲
    description:
      en: Confirm the topic, angle, and structure before writing.
      zh: 动笔前确认选题、切入点和文章大纲。
  article-images:
    icon: post-image
    title:
      en: Images
      zh: 配图
    description:
      en: Review generated illustrations and cover images.
      zh: 审阅文章配图与封面图。
  article:
    icon: article
    title:
      en: Article
      zh: 文章
    description:
      en: Read the full post and destination copies.
      zh: 审阅文章正文与各平台发布版本。
---

Create or revise blog posts using only the Previews the request needs. For a new post,
recommend reviewing the brief and outline (`article-outline`) before making images
(`article-images`) and the article (`article`); follow the task's saved review plan rather
than treating this catalogue as a fixed sequence.

- **Existing work**: read the current article, research, assets and feedback before editing;
  preserve unaffected content and images, and revise only affected destination copies.
- **Facts**: use evidence from the task, project, user or primary sources; ask for missing
  internal facts, personal experience or stance instead of inventing them.
- **Destinations**: use the user's choice, explicit project or Studio rules, then the task
  and existing posts; ask only if these leave the destination unresolved.
- **Files**: keep sources and assets in `<board-state>/assets/<card id>/`, linked from the
  task as `.assets/<card id>/...`; retain working relative paths when copying files.
- **Evidence**: cite primary sources for key facts, concrete cases or further reading;
  narrow, qualify or drop unsupported claims and check that links resolve.
- **Keywords**: use supplied keywords naturally in relevant sections, with the primary one
  in the title, H1 and SEO title; flag a mismatch, never stuff keywords or add a meta keywords
  tag. With none supplied, write metadata from the topic without keyword research.

## Land

Keep the requested files and assets in the task's asset folder. Check final article copies in their
destination formats and record the delivered paths in a checked todo. Publish externally only when requested.

## Previews

<Preview id="article-outline">

Show a brief and outline for the requested post or revision:

- **Brief**: audience, reader goal, language, length, supplied keywords (primary first),
  destinations and angle, including doubts that could change it.
- **Reading**: read existing posts for voice, overlap and internal links; with a primary
  keyword, read top-ranking pages and identify one to three supported points this post adds.
- **Research**: investigate public facts, solutions, limits and counter-examples that could
  change the conclusion; reuse `research.md`, recording each question's conclusion, source
  links, access dates and unresolved facts there, outside the task's review text.
- **Outline**: title, subtitle, SEO title, meta description and destination-required metadata;
  one line per section with its point, cited links and any needed images. A keyword change
  revises the affected brief, metadata and sections together.

Recommended display: brief and outline as Markdown; Asset for a separate outline file.

</Preview>

<Preview id="article-images">

Show only requested images or those needed by the agreed outline, reusing suitable supplied
or existing assets. For new or changed images, follow [image production](references/images.md).
Give each file's section and alt text; show an Asset per image, or one Set with distinct
labels for three or more images. Keep the image's editable source beside it.

</Preview>

<Preview id="article">

Deliver the requested article or revision from the agreed brief or existing article,
research and available images; missing unrequested Previews do not require creating them.

- **Content**: keep the agreed title, metadata, sections, keywords and links, incorporating
  feedback and only supported claims; use the project's voice and destination format.
- **Copies**: deliver one source file per requested destination with its images beside it;
  where posts live as project files, also write the copy and images there, keeping each
  destination separate and its keywords in the format's appropriate fields.
- **Canonical**: for the same post across destinations, use the user's original copy URL in
  each other destination's canonical field, or explain how to set it when publishing.
- **Check**: inspect the finished article in its destination format, checking metadata,
  image paths, alt text and links; keep affected delivered copies consistent.
Show an Asset per destination copy.

</Preview>
