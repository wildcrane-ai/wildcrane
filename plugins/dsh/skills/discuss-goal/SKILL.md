---
name: discuss-goal
description: Use when the user discusses something to build, change or fix; save it as a goal the user starts from the web.
---

Call `wildcrane_draft_read` once per chat with `path` set to the current working directory. Then run `akb guide discuss-goal` and follow it, running the returned `akb` path in place of `akb`, with `WILDCRANE_DISCUSSION=<the returned discussion>` before each command.
