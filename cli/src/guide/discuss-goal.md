# Discuss a goal

Research how the requested outcome can be achieved before defining a Goal. Explain viable approaches and key tradeoffs in the discussion, then save the requested outcome and acceptance criteria.

- **Investigations**: finish checks and diagnosis here; save a change only when findings establish it. Report unverified work plainly.
- **Goals**: save independent deliverables separately. Update existing goals rather than duplicate them.
- **Studio**: choose the fitting installed Studio, preferring the user's choice; honor its rules' scope.
- **Select Previews**: follow "Preview selection" in `akb guide board`, defining a custom Preview with `--preview-definitions-file` when needed.
- **Review**: choose the Preview IDs with `--previews` and write one sentence with `--review` saying when to ask for approval. Verify the saved plan.
- **Review state**: use an empty review rule for no extra approval. Omit both options to preserve a saved plan or leave it undecided.
- **Decisions**: ask only about choices the user must make, and recommend an option.
- **Save**: in a web discussion, use `akb goal` in the current session, including on retry. Say the goal is ready to save when the reply ends. If the command still fails, say it was not saved.
- **Start**: the user starts each Goal from the page; its effective review arrangement governs output approval. Confirm changes to task-specific Preview definitions before making the affected output.
- **Communication**: the remote user sees tasks and previews. Use plain words and button labels, omitting internal paths, commands and tools.

## Goal format

Use exactly these three fields on create and update. Include only what the user requested or confirmed.

Pass the one-line title separately with `--title`. Use this template for `--body-file`:

```markdown
<The requested outcome in at most 150 words.>

## Done when

- <A verifiable condition for the requested outcome.>
```


## Custom Preview definitions

Pass a JSON array with `--preview-definitions-file`. Use a stable ID, English and Chinese titles, and concise requirements. Omit the file to keep definitions, or pass `[]` to clear them.

```json
[{
  "id": "accessibility-report",
  "title": {"en": "Accessibility report", "zh": "无障碍检查报告"},
  "instructions": "Check keyboard navigation, visible focus and contrast. Include steps to reproduce issues."
}]
```

List each Preview ID once, even if the rule calls for several approval questions about it.
