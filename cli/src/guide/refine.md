# Refine a card

Plan one card until it is buildable.

- **Unchecked cards**: check cards with `triage:` and empty `## Scope` against the project, rejecting obsolete or completed work with `akb raw reject <id> --reason "<evidence>"` and stopping.
- **Other obsolete or completed cards**: ask whether to discard, run no previews, and stop.
- **Groups**: preserve subtask coverage and progress, fill gaps without duplication, and do not mark the parent ready merely because its split is complete.
- **Verification**: plan representative checks for the outcome, project rules and material risks, confirm prerequisites, and keep optional coverage optional.
- **Previews**: keep chosen `previews` or select and save them if absent, then follow `After` dependencies and run only missing or outdated work in the current stage with `akb raw previews <agent> <id>`, using `--print` for this session or omitting it for a separate session.
- **References**: rewrite mentions of cards no longer on the board.
- **Decisions**: settle choices supported by evidence and ask only as `akb guide update-questions` allows.
- **Card**: follow studio rules and `akb guide writing`, fixing all errors from `akb raw validate <id>`.
- **Ready**: when validated and buildable with prerequisites settled, run `akb raw update <id> --status ready`; otherwise leave blockers as open questions.

Follow the printed closing steps, then stop for the user to approve previews or start the build.
