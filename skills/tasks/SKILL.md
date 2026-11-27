---
name: tasks
description: Use when the user asks about or acts on WildCrane tasks, their chat history or replies.
---

Start with `akb help`, then read the matching subcommand’s `--help`; `akb project list` and `akb workspace list` name the choices when a project is needed.

- **Changes**: send requested changes to a task's requirement or draft with `akb task chat`.
- **Inspect**: read `akb task chat <task>` without a message for chat history, reply progress or a missing or failed reply, even after the task finishes or stops; inspection does not authorize sending messages or stopping work.
- **Follow**: use `--follow` only when live progress is needed; it tracks the reply present at the start.
- **Stop**: use `akb task chat <task> --stop` when the user asks to stop only the chat reply, and `akb task stop <task>` when they ask to stop task execution.
- **Results**: report task execution and chat reply states separately; acceptance of a message or stop request does not mean completion.
- **Which task**: when the user has not named the task clearly, list the likely ones and ask before acting.
- **Plain words**: reply with the result and the task's web link; omit commands and ids the user did not use.
- **Signed out**: relay the sign-in message as it is.
