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
├── rules/          `studios/<studio>.md` — Studio notes, set with `akb studio rule`
│                   `<agent>.md` — project background-task instructions, set with
│                   `akb studio instructions`
├── triage/         items waiting to be sorted, one file each — not cards. Only
│   │               Cloud's sort or Refine idea on the web's Triage page turns one
│   │               into a card; `akb raw triage check <source-id>` finds an existing one
│   ├── archived/   items a card was made of
│   ├── dismissed/  items ignored, with the reason
│   └── files/      dropped-in files
└── modules.md      one line per module — `akb guide module-map` writes it
```

## Task ID

Every task's id is the number at the front of its filename (`04-plan-cap-enforcement.md` →
id 4): its Cloud task's number (`WC-4`). Only Cloud assigns one.

## Never hand-write a card's frontmatter

`akb raw update`, `akb task update-questions` and `akb raw conflict resolve` manage a card's frontmatter,
including its `previews`. Edit only the card's **body** by hand. `akb raw help`
lists all operations; `akb raw help <move>` explains one operation.

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

Continue from the task's saved discussion, results and approved requirements. Follow explicit
project and Studio rules. Read relevant memory on demand; do not write memory in task runs.
