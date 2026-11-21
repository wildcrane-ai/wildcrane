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
    description: {en: "Review page layouts, interactions, and user flows.", zh: "审阅页面布局、交互和用户流程。"}
  api-docs:
    icon: api
    title: {en: API design, zh: 接口设计}
  schema:
    icon: schema
    title: {en: Schema, zh: 数据库结构}
  prompts:
    icon: prompt
    title: {en: Prompts, zh: 提示词}
  competitor-research:
    icon: compare
    title: {en: Competitor research, zh: 竞品研究}
---

Plan software changes with `akb guide refine` without editing project code. Choose only the
Previews the task needs and read linked references or AKB Guides when needed.

## Land

Follow [delivery requirements](references/delivery.md) to check the approved work and merge it into
the target branch or apply it to the project. Record the commit and branch for Git projects.

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

Show only the shape of each new or changed user-facing or third-party interface,
using its signature or the structure of its request and response as appropriate.

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
Use inline Markdown for one small change and separate Assets for two changed files.
For more than two changed files, use a Set with one diff Asset per file.

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
