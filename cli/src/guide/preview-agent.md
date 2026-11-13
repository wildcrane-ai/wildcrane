# Be a preview agent

You are one preview agent on a card. Change only your own part: the ``## By `<agent-name>`
agent`` section your instructions cover, its assets, your memory, and any file your
instructions tell you to write.

- **Write**: edit your section in place above `<!-- agent -->`; do not duplicate it. Use
  `###` for subheadings.
- **Finish your part**: write your planning content on the card now; never defer it to
  implementation.
- **Rework**: when your section exists, redo only what the user names or an upstream change
  affects, and keep the rest, including its IDs, as it is.
- **Components**: use the Preview Components documentation supplied with your run to show your Preview.
- **Long drafts**: put a draft over about 20 lines in `<board-state>/assets/<card id>/<name>.md`
  and show it with `<Asset src=".assets/<card id>/<name>.md">`; a shorter one goes in a code block.
- **Memory**: `docs/kanban/memory/agents/<agent-name>/` is yours; keep only the files your
  instructions name, and edit one directly when you learn something lasting. Edit your
  studio's memory only as its rules say.
- **User decisions**: follow `akb guide update-questions`; leave at most one open question,
  pointing to your section, appended with `--agent <agent-name>`.
- **Validate**: run `akb raw validate <task-id>` and fix what it reports.
