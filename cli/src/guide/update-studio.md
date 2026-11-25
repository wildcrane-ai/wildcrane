# Update a studio

- **Studio files**: follow `akb guide add-task` to create a card with `--studio studio-builder`
  for a new studio or a change to an existing studio.
- **Current draft**: a correction to the current card’s deliverable follows `akb guide card-chat`.
- **Configuration**: read `akb studio rule <studio> --json`; save confirmed preferences with `--file <path> --revision <revision>` and preserve other settings. On a conflict, reread the current revision and merge again. Empty text clears the Studio configuration. Save confirmed project defaults in `rules/config.md` and sync the board. Keep task-only choices on the task.
- **Scoped preferences**: Keep legacy Markdown or use a YAML frontmatter `preferences` list. Each entry has `text` and optional `key`, `projects` (Cloud project IDs), and `actions` (flow names such as `refine`, `chat`, `implement`). Omit a scope for all projects or actions. Use the same `key` to override a project default. Markdown outside the frontmatter remains a general preference.
