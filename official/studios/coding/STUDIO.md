---
name: Coding
names:
  zh: 软件开发
description: Plan and deliver changes to repository code, documentation, agent instructions, skills, and other project files. Handle general project work when no specialized Studio fits.
summaries:
  zh: 先确认改动方案，再写代码。
  en: Approve the plan, then the code gets written.
needsArtifact: false
allowedFollowUps: |
  Allow:
  - Refactors or optimizations with substantial, demonstrable benefits.
  - Fixes for clearly evidenced bugs.
  - Significant gaps in existing functionality.

  Avoid:
  - Fixes for unreproducible or unverified bugs.
  - Issues already resolved by current code or covered by existing board tasks (queued, in progress, in review, etc.).
  - Overdesign, speculative abstractions, or low-value polish.
  - Release, deployment, publishing, or standalone verification/testing tasks — those are the user's call.
  - Redundant mechanisms, entry points, or artifacts for needs already met by existing functionality.
  - Defensive guards for contrived or unsupported edge cases (e.g., manual data tampering or test-only states).
  - Work on deprecated, retired, or unmaintained components.
icon: software
previews:
  bug-context:
    icon: notebook
    title: {en: Bug context, zh: Bug 上下文}
    description: {en: "Review bug context, visual captures, and reproduction steps before fixing.", zh: "在修复前审阅 Bug 上下文、截图录屏或可复现步骤与关键现场。"}
  tech-choices:
    icon: stack
    title: {en: Tech choices, zh: 技术选型}
    description: {en: "Compare libraries, tools, or services before deciding.", zh: "对比候选库、工具或服务方案后再做决定。"}
  emails:
    icon: email
    title: {en: Emails, zh: 邮件}
    description: {en: "Preview email subjects, copy, and mobile/desktop layouts.", zh: "预览邮件主题、正文以及桌面和移动端排版。"}
  ui-design:
    icon: screen
    title: {en: UI design, zh: 界面设计}
    description: {en: "Review page layouts, interactions, and user flows.", zh: "审阅页面布局、交互和用户流程。"}
  api-docs:
    icon: api
    title: {en: API design, zh: 接口设计}
    description: {en: "Review new or updated APIs, CLI commands, and schemas.", zh: "审阅新增或变更的接口签名与数据结构。"}
  schema:
    icon: schema
    title: {en: Schema, zh: 数据库结构}
    description: {en: "Review table changes, migrations, and data risks.", zh: "审阅表结构变更、迁移方案与潜在风险。"}
  compatibility:
    title: {en: Compatibility, zh: 兼容性}
    description: {en: "Review external breaking changes that require weighing backward compatibility options.", zh: "审阅需要人工权衡向后兼容方案的外部破坏性变更。"}
  prompts:
    icon: prompt
    title: {en: Prompts, zh: 提示词}
    description: {en: "Review changes to agent prompts, skills, and instructions.", zh: "审阅提示词、技能或指令文件的修改。"}
  competitor-research:
    icon: compare
    title: {en: Competitor research, zh: 竞品研究}
    description: {en: "Compare competitor capabilities side by side.", zh: "横向对比竞品能力与我们的设计取舍。"}
---

## Planning

Plan software changes with `akb guide refine` without editing project code. Choose only the
Previews the task needs and read linked references or AKB Guides when needed.

## Work

Follow `akb guide implement` and the project's instructions. Use the [implementation requirements](references/implement.md) to build and verify changes.

## Land

Follow the [landing requirements](references/land.md) to verify the saved work, apply any pending changes, and archive the task.

## Previews

Read relevant files under `docs/kanban/memory/previews/coding/<preview-id>/{project,workspace}/` on demand.
These folders keep confirmed lasting preferences, rules and corrections; new notes belong to
`project/` unless the user explicitly confirms cross-project reuse in `workspace/`.
Files under `.conflicts/` are unresolved sources, not confirmed rules.

<Preview id="bug-context">

Use for bug fixes when showing the bug context helps reviewers verify the issue before
implementation; skip for new features, refactors, and other non-bug work. Present the bug context
briefly in the clearest reviewable form:
- **Visual or interaction bugs**: capture screenshots or a short recording when feasible and attach them with `<Asset>` (use `<Set>` for multiple captures or states).
- **Non-visual or uncapturable bugs**: state minimal reproduction steps, observed vs. expected behavior, and key evidence (logs, errors, or code references).

</Preview>

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

Design requested copy, images, or screens using the project's design:
- **Copy or docs**: show full MD/MDX for new or reorganized files, diff for existing,
  `Field: value` per field for sourceless text, and navigation placement for new pages.
- **Images or animation**: prefer programmatic illustration (TSX, HTML, CSS, SVG); show
  animation as `.mp4` with `<Asset src="..." loop />`.
- **Screens**: use [landing-page](skills/landing-page/SKILL.md) for new promotional pages and
  [ui-mockup](skills/ui-mockup/SKILL.md) for screens based on existing product source.
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

<Preview id="compatibility">

Use only when a change breaks existing use by external users, clients, or integrations
and a reviewer needs to weigh backward compatibility options.
Skip internal database migrations, refactors, and routine fixes that delivery can safely
handle without user action.

Briefly state what breaks, who is affected, and the recommended migration with its compatibility tradeoff.

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
archive todo):

| | <Competitor> | Ours |
| --- | --- | --- |
| <aspect> | <how they do it, or "None"> | <how this card does it> |

**Verdict**: <what to borrow, and where we differ on purpose — one or two sentences>.

Sources use linked evidence pages.

Recommended display: inline Markdown table; Asset for a requested report.

</Preview>
