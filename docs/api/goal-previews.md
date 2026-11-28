# Goal review plans

The effective catalog combines the Studio’s Previews and the Goal’s custom definitions. A Goal or Task uses `{ rule, previews }` to save when to ask for approval and which Preview IDs to use. `null` means undecided. Legacy dependency arrays remain supported. See [Task reviews](task-review.md).

## CLI

```sh
akb goal new --title "Write the copy" --body-file goal.md --previews copy --review 'Approve the idea, then approve final copy.'
akb goal save --id "$goal_id" --review 'Write final copy and ask for approval.'
akb task create 'Write the copy' --studio editorial --previews copy --review 'Approve final copy.'
akb task review W-818 --previews copy,examples
```

Select Preview IDs with `--previews` to start a flat plan. Thereafter, changing either option preserves the other. Pass `--previews ''` to clear the list or `--review ''` to ask for no extra approval. Leaving all plan options out preserves the saved plan or leaves a new plan undecided. Legacy named flows and JSON node files continue to work.

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
- **Legacy plans**. Goal `--review-file` and Task review `--file` accept JSON nodes with Preview IDs from the effective catalog. Each review node needs at least one Preview. Ordinary work nodes (`kind: "work"`) and the terminal delivery handoff may have an empty Preview list.

`POST /v1/discussions/{id}/goals/{goal}/start` takes `{ expectedVersion?, action?, project?, machine?, runtime? }` and returns the Task with status 201. A stale version returns `409/version_conflict`. External discussions require `expectedVersion` and can retry to recover the same Task.

- `action: "start"` copies the saved definitions and plan. An empty plan starts implementation. A plan with review points starts refinement. An undecided plan returns `409/conflict`.
- `action: "refine"` starts with refinement and copies the flat plan and Preview definitions. A legacy plan is supplied as context for refinement.
- Omitting `action` starts refinement for an undecided plan and uses the saved plan when available.
- `runtime` selects the environment for the first operation. Implementation after refinement uses its own runtime selection.

Example request body: `{"expectedVersion":2,"action":"refine"}`.
