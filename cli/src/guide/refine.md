# Refine a card

Plan only what is needed to make the requested outcome buildable; skip further planning when it already is.

- **Unchecked cards**: check cards with `triage:` and empty `## Scope` against the project, rejecting obsolete or completed work with `akb task remove <id> "<evidence>"` and stopping.
- **Other obsolete or completed cards**: ask whether to discard, run no previews, and stop.
- **Groups**: preserve subtask coverage and progress, fill gaps without duplication, and leave the parent open while subtasks remain.
- **Verification**: plan representative checks for the outcome, project rules and material risks, confirm prerequisites, and keep optional coverage optional.
- **Review**: read `akb task review <id>`. If undecided, evaluate needed Previews against the Studio's rules and “Preview selection” in `akb guide board`, then save `--previews <ids>` (use `""` when none is needed) and `--review <rule>`. Use an empty rule for no extra approval.
- **Previews**: follow the Studio's Preview rules (including any requirements for triage or agent-proposed tasks), write each selected `<Preview id="...">` block, sync it, and follow the saved review rule.
- **Delivery**: the Studio's delivery flow handles separate implementation and its checks.
- **References**: rewrite mentions of cards no longer on the board.
- **Decisions**: settle in-scope choices by project evidence and conventions; ask before changing scope and only as `akb guide update-questions` allows.
- **Card**: follow studio rules and `akb guide writing`, fixing all errors from `akb task validate <id>`.
- **Planning complete**: run `akb task update <id> --status planned` once the card validates and has no open questions.

Follow the printed closing steps. Wait only for required approvals; completion still requires Studio delivery checks.
