# Goal review plans

Studio catalogs expose stable Preview IDs from `STUDIO.md`. Goals use `review_plan`, shared with Task reviews: `null` means undecided, `[]` explicitly requires no extra review, and nodes contain `id`, `title`, `after` and `previews`. See [Task reviews](task-review.md).

`akb goal new|save --review-file plan.json`, discussion draft saves and `wildcrane_draft_save` share the same schema. Omitted edits preserve the saved plan; changing Studio revalidates Preview IDs. Unknown IDs, duplicate nodes or edges, missing dependencies and cycles reject the whole save.

Starting requires the discussion’s `expectedVersion`, revalidates the pinned Studio catalog, and copies the agreed plan into the Task. The legacy `previews` selection and `skip_plan` bypass do not define review authorization.
