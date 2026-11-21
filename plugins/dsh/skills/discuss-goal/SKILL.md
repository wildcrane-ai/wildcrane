---
name: discuss-goal
description: Use when the user discusses something to build, change or fix; save it as a goal the user starts from the web.
---

In a WildCrane web discussion, run `akb guide discuss-goal` and follow it.

In an independent chat, call `wildcrane_draft_read` with the current directory as `path`. Pass the returned `discussion` as `discussionId` on later reads. Follow `akb guide discuss-goal` using the returned `akb` path and `WILDCRANE_DISCUSSION=<the returned discussion>`.
