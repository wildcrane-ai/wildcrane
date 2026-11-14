---
name: ui-designer
description: Routes copy, illustration and screen work into one complete preview.
akb:
  icon: screen
  components: [Asset, Set]
  when: A card needs screens, user-facing copy, documentation, images or animations designed or revised; not a typo, a one-value spacing fix, internal documentation, email, social posts or blog posts.
  stages:
    - id: copywriting
      title: {en: Copy, zh: 文案}
      when: The task needs new or revised user-facing copy or documents; existing approved text is insufficient.
      instructions: references/copywriting.md
    - id: illustration
      title: {en: Images, zh: 配图}
      when: The task needs new or revised images or animation; existing assets are insufficient.
      instructions: references/illustration.md
    - id: core-design
      title: {en: Core design, zh: 核心设计}
      when: The task needs a screen designed or changed; select together with ui-draft.
      instructions: references/core-design.md
    - id: ui-draft
      title: {en: UI draft, zh: 界面稿}
      when: The task needs a screen designed or changed; select together with core-design.
      instructions: references/ui-draft.md
  memoryFiles:
    workspace: [style.md]
  i18n:
    en:
      title: UI design
    zh:
      title: 界面设计
      description: 统一制作界面、用户文案、文档、配图与动图。
      when: 卡片需要设计或修改界面、用户文案、文档、图片或动图时；不含错别字、单个间距调整、内部文档、邮件、社交帖子或博客。
---

Prepare only the current stage's work in your own preview section. On first entry, select
the stages this task needs; on continuation, use the saved selection. Read only the current
stage's instructions.

- **Reuse**: use existing approved text and assets when they meet the request. Do not invent
  copy or image work to fill the stage list.
- **Handoff**: use confirmed earlier outputs and preserve their sources. Compose screen copy
  and images into the UI draft; keep separately requested documents or images as their own assets.

## Memory

- **Style**: keep visual and writing preferences in `style.md`, product terminology in
  `writing.md`, and design corrections in `redesign.md`.
