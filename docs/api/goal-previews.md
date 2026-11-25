# Goal review plans

The effective catalog combines the bound Studio’s Previews from `STUDIO.md` and the Goal’s own definitions. Goals use `review_plan`, shared with Task reviews: `null` means undecided, `[]` explicitly requires no extra review, and nodes contain `id`, `after` and `previews`. See [Task reviews](task-review.md).

## CLI

- `akb goal new|save ... --review '<flow>'` saves a Goal's review plan.
- `akb task review <task> --review '<flow>' --revision <n>` updates the Task’s review arrangement. Changes to the custom definitions require confirmation.

Use Studio or explicitly defined custom Preview names in any declared language. Join parallel Previews with `+` and consecutive groups with `->`. A pending dependent Preview waits for every required approval in the previous group. A Preview is a draft or result for review. Keep task context in the Goal body.

```sh
akb goal save --id "$goal_id" --preview-definitions-file goal-previews.json \
  --review 'UI design -> Accessibility report'
```

Use `--review ''` to select no extra review. Omitting the option leaves a new Goal's plan undecided or keeps an existing Goal's saved plan.

Empty entries, repeated Previews, and unknown or ambiguous names fail the write. Errors identify the failing entry and list available display names and IDs.

The definitions file contains the complete custom list.

```json
[{
  "id": "accessibility-report",
  "title": {"en": "Accessibility report", "zh": "无障碍检查报告"},
  "instructions": "Check keyboard navigation, visible focus and contrast.",
  "components": ["Asset"]
}]
```

- **Limits**. Use up to 50 definitions with stable lowercase IDs, English and Chinese titles of up to 100 characters, and nonblank instructions of up to 10,000 characters. Omit `components` to allow all standard Preview Components.
- **Draft**. `GET /v1/discussions/{id}` and `wildcrane_draft_read` return definitions per Goal. The tool also returns Studio Preview display names. `PUT /v1/discussions/{id}/draft` and `wildcrane_draft_save` accept `preview_definitions?` and either `review_flow` or `review_plan` per Goal, under `goals`. Omitting definitions preserves the saved list. An explicit `[]` clears it.
- **Validation**. Invalid plans or definitions reject the entire write and preserve the saved draft. The HTTP endpoint returns `400 bad_request`, the MCP tool returns `isError: true`, and the CLI exits with a nonzero status. `PATCH /v1/discussions/{id}/goals/{goal}` validates the saved plan and definitions against the selected Studio before changing it. Concurrent changes return `409/version_conflict`.
- **Structured plans**. Goal `--review-file` and Task review `--file` accept JSON nodes with Preview IDs from the effective catalog. Each review node needs at least one Preview. Ordinary work nodes (`kind: "work"`) and the terminal delivery handoff may have an empty Preview list.

`POST /v1/discussions/{id}/goals/{goal}/start` takes `{ expectedVersion, action?, project?, machine? }` and returns the Task with status 201. A stale version returns `409/version_conflict`. External discussions can retry to recover the same Task.

- `action: "start"` copies the saved definitions and plan to the Task and starts the available work. An undecided plan returns `409/conflict`.
- `action: "refine"` drafts the Task using the copied definitions and saved plan as context. The resulting plan takes effect when submitted, and its review gates govern subsequent work.
- Omitting `action` keeps the earlier behavior. An undecided plan goes to planning and a saved plan goes into the Task. Legacy `skip_plan` is accepted for compatibility.

Example request body: `{"expectedVersion":2,"action":"refine"}`.
