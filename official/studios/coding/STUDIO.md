---
name: Coding
names:
  zh: 软件开发
description: Plan and deliver software changes, and work no other Studio covers.
needsArtifact: false
icon: software
previews:
  tech-choices:
    icon: stack
    title: {en: Tech choices, zh: 技术选型}
  emails:
    icon: email
    title: {en: Emails, zh: 邮件}
  ui-design:
    icon: screen
    title: {en: UI design, zh: 界面设计}
  api-docs:
    icon: api
    title: {en: API docs, zh: 接口文档}
  schema:
    icon: schema
    title: {en: Schema, zh: 数据结构}
  prompts:
    icon: prompt
    title: {en: Prompts, zh: 提示词}
  competitor-research:
    icon: compare
    title: {en: Competitor research, zh: 竞品研究}
---

Plan software changes with `akb guide refine` without editing project code; deliver approved
work through local checks and merge with `akb guide implement` and
[delivery requirements](references/delivery.md). Choose only the Previews the task needs,
keep outputs concise, and read linked references or AKB Guides only when needed.

## Preview memory

Read relevant files under `docs/kanban/memory/previews/coding/<preview-id>/{project,workspace}/` on demand.
These folders keep confirmed lasting preferences, rules and corrections; new notes belong to
`project/` unless the user explicitly confirms cross-project reuse in `workspace/`.
Files under `.conflicts/` are unresolved sources, not confirmed rules.

<Preview id="tech-choices">

Compare needed outside libraries, tools or services (always including keeping what is already
used and writing it ourselves); recommend on technical merits and ask an open question
(`akb guide update-questions`) for paid services, accounts, or vendor lock-in:

| Option | What it is | Pros | Cons |
| --- | --- | --- | --- |
| <name> | <half a line, with the version and licence you checked> | <what it gives this card> | <what it costs this card> |

**Pick: <name>** — <why it beats the others here, in one line>.

</Preview>

<Preview id="emails">

Write and render requested emails (subject, preview text and body) following
[email guide](references/emails.md).
Recommended display: desktop HTML, `device="mobile"` HTML and `.txt` Assets for one email;
Set for several.

</Preview>

<Preview id="ui-design">

Design requested copy, images, or screens in the existing product design:
- **Copy or docs**: show full MD/MDX for new or reorganized files, diff for existing,
  `Field: value` per field for sourceless text, and navigation placement for new pages.
- **Images or animation**: prefer programmatic illustration (TSX, HTML, CSS, SVG); show
  animation as `.mp4` with `<Asset src="..." loop />`.
- **Screens**: follow [screen rendering](references/ui/rendered-screen.md).
Recommended display: Asset for one screen; Set for several screens or states.

</Preview>

<Preview id="api-docs">

Write caller documentation for changed user or third-party interfaces (inputs, outputs,
errors and one example) in the project's docs style: use a unified `diff` for existing
entries and a `mermaid` `sequenceDiagram` for message exchanges.
Recommended display: inline Markdown for a small entry; Asset for a document or its diff.

</Preview>

<Preview id="schema">

Give one schema design (migration and backfill scripts belong to delivery): a DDL `diff`
of touched tables only, a `mermaid` `erDiagram` only when a foreign key is added or
repointed, and a one-line note only for risks that affect review (destructive, backfill,
rollback).
Recommended display: Asset for the diff; inline Markdown for the note.

</Preview>

<Preview id="prompts">

Show changed instructions (unified `.diff` per target), following `akb guide write-prompt`;
include a one-line reason per file only when needed for review. When prompt context changes,
list what it is, its source, target prompt, rough size, and one-sentence reason.
Recommended display: inline Markdown for one small change, Assets for two changed files,
or Set for more than two files.

</Preview>

<Preview id="competitor-research">

Compare relevant competitors beside our design (for named competitors without a planned
feature, write one capability table per competitor; for research-only cards, write a single
archive todo and never mark `ready`):

| | <Competitor> | Ours |
| --- | --- | --- |
| <aspect> | <how they do it, or "None"> | <how this card does it> |

**Verdict**: <what to borrow, and where we differ on purpose — one or two sentences>.

Sources use linked evidence pages.

Recommended display: inline Markdown table; Asset for a requested report.

</Preview>
