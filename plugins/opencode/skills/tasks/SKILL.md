---
name: tasks
description: Use when the user asks about or acts on their WildCrane tasks, such as listing, creating, approving, changing, removing, resuming, stopping or commenting on one.
---

Call `wildcrane_status` once per chat with `path` set to the current working directory, only for its `akb` path, and run that path in place of `akb`. Do it with `akb task` (see `akb task --help`); `akb project list` and `akb workspace list` name the choices when a project is needed.

- **Changes**: send requested changes to a task's requirement or draft with `akb task chat`.
- **Which task**: when the user has not named the task clearly, list the likely ones and ask before acting.
- **Plain words**: reply with the result and the task's web link; omit commands and ids the user did not use.
- **Signed out**: when the user is not signed in, relay the sign-in message as it is.
