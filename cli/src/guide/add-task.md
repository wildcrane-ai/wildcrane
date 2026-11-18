# Add tasks

Create new work with `akb task create`; read its `--help` for options.

- **Modules**: read `docs/kanban/modules.md` and relevant project context; follow
  `akb guide module-map` when no tag fits.

## Group tasks

Use a group when several tasks deliver one larger outcome; otherwise keep them independent.

- **Creation**: create the root first, then its subtasks.
- **Relationships**: link group members with `related`; use `blocked_by` for actual dependencies.
- **Layout**: once their cards are prepared, place the root at `todo/<id>-<slug>/root.md`
  and the subtask files beside it; update their paths in `todo/README.md`.
- **Tracking**: the root's `## Todo` lists its subtasks, one line each ending in `#<subid>`.

Follow `akb guide writing` when editing a card.
