# How this board works

These rules apply to every card studio. Read them once; each studio's guide covers
the remaining details.

## Layout

```
docs/kanban/
├── todo/           open tasks
│   ├── README.md   the index — read it first
│   └── <id>-<slug>.md
│                   one card per file; a group keeps its cards in one folder
├── rules/          `config.md` — project defaults; `studios/<studio>/config.md` — Studio configuration
│                   `<agent>.md` — project background-task instructions, set with
│                   `akb studio instructions`
├── triage/         items waiting to be sorted, one file each — not cards. Only
│   │               Cloud's sort or Refine idea on the web's Triage page turns one
│   │               into a card; `akb triage check <source-id>` finds an existing one
│   ├── archived/   items a card was made of
│   ├── dismissed/  items ignored, with the reason
│   └── files/      dropped-in files
└── modules.md      one line per module — `akb guide module-map` writes it
```

## Task ID

Every task's id is the number at the front of its filename (`04-plan-cap-enforcement.md` →
id 4): its Cloud task's number (`WC-4`). Only Cloud assigns one.

## Never hand-write a card's frontmatter

Edit the card body directly. Use `akb task update` for card fields,
`akb task update-questions` for questions, and `akb task review` for the review plan.

Find commands with `akb help`, then read the matching subcommand's `--help`.

## Content conflicts

For synchronization conflicts, follow `akb guide resolve-conflict`.

## Inside a board run

A board run carries `KANBAN_RUN` in its environment. Never unset or bypass it (for example
`env -u KANBAN_RUN`): when a command only prints a flow, follow the printed flow.

## Group task

A group lives in `todo/<id>-<slug>/`: `root.md` tracks the whole job and each subtask is its
own card beside it; `akb guide add-task` says how to build one. The root's `## Todo` lists the
subtasks, one line each ending in `#<subid>`: archiving a subtask ticks its line, rejecting
one strikes it through, and resolving the last line archives the root in the same run, with
any open question or unticked todo of its own. A board a Runner keeps leaves that close to
Cloud, which waits for the root to be queued with no step on it. A root listing no subtasks is
only closed by hand.

## Task context

Use `akb task show <task>` for the current card, Review, Preview references and saved materials.
Check the current Studio instructions, shared rules and project and Studio configurations before
working. Read linked files, applicable Preview definitions, component documentation and memory
as needed. Write results in matching Preview blocks and preserve unrelated work. When reading scoped
preferences for a specific output, match its configuration to the current action and the task's
project (`akb task show <id> --json`).

Save task assets in the `Asset folder` shown by `akb task show <id>`.
In the card, reference a file by its path within that folder, for example `asset:home.html`.

Reread configuration before Land and after a Setup answer. Studio preferences override project
defaults for the same key. Ask through `akb guide update-questions` when a required Setup choice
first matters. Pause the dependent action and use declared defaults for optional choices.
Check required credentials on the executing Runner without printing secrets. Use a read-only
check when available. If missing or invalid, ask the user to configure them locally or follow
the Studio's fallback. Keep credentials out of cards, configuration, synced files and logs. Do not write memory in task runs.

## Preview selection

- **Read the Studio first**: before choosing Previews, read its `STUDIO.md` (`akb studio file <studio> STUDIO.md`), relevant linked files, and its configuration (`akb studio rule <studio>`).
- **Built-in Previews first**: match deliverables that need review to the Studio's built-in Previews; never replace a built-in Preview with a custom one or mix a built-in Preview's deliverable into a custom Preview.
- **Custom Previews as fallback**: define a custom Preview only when built-in Previews cannot cover a deliverable that needs review, and leave general task plans in the card or goal body unless the Studio defines a Preview for them.
