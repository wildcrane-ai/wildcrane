# Refine a card

Plan one card until it is buildable.

- **Unchecked cards**: check cards with `triage:` and empty `## Scope` against the project, rejecting obsolete or completed work with `akb task remove <id> "<evidence>"` and stopping.
- **Other obsolete or completed cards**: ask whether to discard, run no previews, and stop.
- **Groups**: preserve subtask coverage and progress, fill gaps without duplication, and do not mark the parent ready merely because its split is complete.
- **Verification**: plan representative checks for the outcome, project rules and material risks, confirm prerequisites, and keep optional coverage optional.
- **Review**: read `akb task review <id>`. If undecided, submit `--review <flow>` with Preview names or `--file <json>` with Preview IDs, plus `--revision <n>`. Use `--review ''` when no extra review is needed. Work only on dispatched, unlocked nodes and continue independent work during review.
- **Context and Previews**: follow "Task context" and "Preview selection" in `akb guide board`. Attach any custom definition with `--preview-definitions-file`.
- **Previews**: prepare only the unlocked nodes’ outputs per the Studio’s `<Preview>` blocks. Before revising an approved output, use `--revise-from <stage> --revision <n>`; preserve unrelated outputs and approvals.
- **Submit**: synchronize body and assets, then report `--stage <id> --status done --revision <n>`. Re-read after conflicts; obtain output approval at the required stages.
- **Delivery**: the Studio's delivery flow handles separate implementation and its checks.
- **References**: rewrite mentions of cards no longer on the board.
- **Decisions**: settle choices supported by evidence and ask only as `akb guide update-questions` allows.
- **Card**: follow studio rules and `akb guide writing`, fixing all errors from `akb task validate <id>`.
- **Ready**: when validated and buildable with prerequisites settled, run `akb task update <id> --status ready`; otherwise leave blockers as open questions.

Follow the printed closing steps. Wait only for required approvals; completion still requires Studio delivery checks.
