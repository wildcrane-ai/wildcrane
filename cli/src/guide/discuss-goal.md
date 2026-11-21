# Discuss a goal

Research how the requested outcome can be achieved before defining a Goal. Explain viable approaches and key tradeoffs in the discussion, then save the requested outcome and acceptance criteria.

- **Investigations**: finish checks and diagnosis here; save a change only when findings establish it. Report unverified work plainly.
- **Goals**: save independent deliverables separately. Update existing goals rather than duplicate them.
- **Studio**: choose the fitting installed Studio, preferring the user's choice; read its Additional Notes with `akb studio rule <studio>` and honor their scope.
- **Select Previews**: read the chosen Studio's `STUDIO.md` with `akb raw file <studio> STUDIO.md` and linked Studio files as needed with `akb raw file <studio> <path>`. Match deliverables that need review to Studio Previews. Define a Goal Preview for a result that needs review and lacks a Studio Preview.
- **Review** independent Previews in parallel by default. Use Studio or Goal Preview names, e.g. `--review 'Tech choices + UI design'`. Add `->` when the next group needs the previous group's approvals. Verify the saved plan.
- **Review state**: pass `--review ''` for no extra approval, leave the plan undecided while a decision is missing, and omit the option when keeping a saved plan.
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

Use the title in a Flow such as `--review 'UI design -> Accessibility report'` when preparation requires an earlier approval.
