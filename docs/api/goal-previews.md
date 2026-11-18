# Goal review plans

Studio catalogs expose stable Preview IDs from `STUDIO.md`. Goals use `review_plan`, shared with Task reviews: `null` means undecided, `[]` explicitly requires no extra review, and nodes contain `id`, `after` and `previews`. See [Task reviews](task-review.md).

`akb goal new|save --review-file plan.json`, discussion draft saves and `wildcrane_draft_save` share the same schema. Omitted edits preserve the saved plan; changing Studio revalidates Preview IDs. Unknown IDs, duplicate nodes or edges, missing dependencies and cycles reject the whole save.

`POST /v1/discussions/{id}/goals/{goal}/start` takes `{ expectedVersion, action?, project?, machine? }` and returns the Task with status 201. The legacy `/ideas/` route is an alias. A stale version returns `409/version_conflict`. External discussions can retry to recover the same Task.

- `action: "start"` copies the saved plan to the Task and starts the available work. An undecided plan returns `409/conflict`.
- `action: "refine"` drafts the Task using the saved plan as context. The user confirms the resulting plan before any stage or implementation runs.
- Omitting `action` keeps the earlier behavior. An undecided plan goes to planning and a saved plan goes into the Task. Legacy `skip_plan` is accepted for compatibility.

Example request body: `{"expectedVersion":2,"action":"refine"}`.
