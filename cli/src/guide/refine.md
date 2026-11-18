# Refine a card

Plan one card until it is buildable.

- **Unchecked cards**: check cards with `triage:` and empty `## Scope` against the project, rejecting obsolete or completed work with `akb raw reject <id> --reason "<evidence>"` and stopping.
- **Other obsolete or completed cards**: ask whether to discard, run no previews, and stop.
- **Groups**: preserve subtask coverage and progress, fill gaps without duplication, and do not mark the parent ready merely because its split is complete.
- **Verification**: plan representative checks for the outcome, project rules and material risks, confirm prerequisites, and keep optional coverage optional.
- **Review**: read `akb task review <id>`. If the arrangement is undecided, propose it with `--file <json> --revision <n>` and wait for confirmation. Work only on dispatched, unlocked nodes; keep independent work moving while other nodes await review.
- **Previews**: prepare only the unlocked nodes’ outputs per the Studio’s `<Preview>` blocks. Before revising an approved output, use `--revise-from <stage> --revision <n>`; preserve unrelated outputs and approvals.
- **Submit**: synchronize body and assets, then report `--stage <id> --status done --revision <n>`. Re-read after conflicts; never treat submission, question answers or plan confirmation as product approval.
- **Delivery handoff**: for Studios with separate delivery, finish the review plan with a handoff; implementation and its checks run in delivery.
- **References**: rewrite mentions of cards no longer on the board.
- **Decisions**: settle choices supported by evidence and ask only as `akb guide update-questions` allows.
- **Card**: follow studio rules and `akb guide writing`, fixing all errors from `akb raw validate <id>`.
- **Ready**: when validated and buildable with prerequisites settled, run `akb raw update <id> --status ready`; otherwise leave blockers as open questions.

Follow the printed closing steps. Wait only for required approvals; completion still requires Studio delivery checks.
