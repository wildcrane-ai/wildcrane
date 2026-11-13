# Write an agent

Create `docs/kanban/agents/<name>/AGENT.md`; use an unused lowercase, hyphenated name matching
the folder. Its studio lists it under `previews`, `land` or `scheduled` in `STUDIO.md`.

## Example: a preview agent

```yaml
---
name: page-designer
description: Makes complete page designs with their copy.
akb:
  when: A card needs a page designed or changed.
  icon: screen
  components: [Asset, Set]
  i18n:
    en:
      title: Page design
    zh:
      title: 页面设计
  stages:
    - id: copy
      title: {en: Copy, zh: 文案}
      when: The page needs new or revised copy; existing text is insufficient.
      instructions: references/copy.md
    - id: layout
      title: {en: Page layout, zh: 页面稿}
      instructions: references/layout.md
---

Choose the stages this task needs on first entry; reuse the saved selection on continuation.
Follow the current stage's instructions, preserving confirmed copy in the page design.
```

With existing copy, this agent selects only `layout`; otherwise it selects `copy,layout`.
Each selected step except the last waits for user confirmation. The last is ready for the
card's approval. The agent chooses its steps, not the planner; the program saves and advances
them. Omit `stages` for a single preview. Stage IDs are unique; instruction paths stay inside
the agent folder. A task freezes its definition, files and selection.

**Legacy**: `after` remains readable for frozen workflows; use internal stages for new agents.

## Other fields

Only `name`, `description` and nonempty body instructions are required. Omit unused fields.

| Field | Use |
| --- | --- |
| `akb.when` | When to request a preview; omitted means every task on its studio. |
| `akb.session: new` | Run a preview in its own session. |
| `akb.components` | Asset, Set, Compare or Storyboard; default `[Asset]`, `[]` loads no component docs. |
| `akb.icon` | Glyph name, or 1–12 `{d, f?, o?: true, s?, w?}` parts using supported colours. |
| `akb.i18n` | Display-only title, description and when by language; missing text falls back to English. Keep titles short and name the output. |
| `akb.reads` | Scheduled input: `archived-cards`, `chats` or `dismissals`; omitted uses cadence alone. Set fixed cadence on the studio's scheduled entry. |
| `akb.merges: true` | A land agent merges code; completion requires its merged commit and branch. |
| `akb.memory` | Names of shared global memories. |
| `akb.memoryFiles.workspace` | Paths such as `[style.md]` shared across projects within this agent's memory. |

## Instructions and files

- **Keep the body small**: say what the agent owns and delivers. Use `akb guide write-prompt`;
  do not repeat `preview-agent` rules. Stage-specific work belongs in its instruction file.
- **Load on demand**: files beside AGENT.md are listed to the run. Put shared studio material
  in `shared/`; keep scripts and business validation with their owning agent, documenting
  runtime and invocation. Retrieve bundled files with `akb raw file <studio> <path>`.
- **Memory**: keep only preferences or corrections that change future work. Name each file's
  purpose and when to read it; omit transcripts and duplicated rules. Agent memory is under
  `docs/kanban/memory/agents/<name>/`; studio memory follows its `shared/RULES.md`. Agree on
  any scheduled agent's persistent state rather than inventing its format.
- **User decisions**: follow `akb guide update-questions`; do not ask again about settled
  choices. Show each changed file as a unified diff with one sentence explaining why.

## Imported skills

Keep each skill whole under `skills/<skill>/`, including instructions, scripts, resources and
license; exclude caches and installed packages. Record its source and version in AGENT.md:
`- **<skill>**: <when to use>. Source: <URL or pasted> @ <commit, tag or date>`.
Adapt routing outside the skill, preserving its relative paths. Report missing files, tools
or credentials; never copy keys or claim an unusable skill works. Update or remove only when
asked, replacing the whole owned copy and showing the diff and version.

## Check

Run `akb raw previews` and `akb raw previews --triggers`; fix every reported problem.
Then inspect `akb raw previews <name> <id> --print` on a real task and trim unnecessary context.
Use `akb raw components --agent <name> --docs` for output formats. New agents start enabled
in their studio; disabled previews cannot run. Keep registration and instructions consistent.
