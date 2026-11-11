# Implement the approved requirements

Build the approved card or plan directly. Preserve settled decisions and unrelated questions;
do not replace or contradict the approved requirements. With no card, build only the given
requirement and create no card.

- **Check applicability**: use the working directory, project instructions, configuration
  sources and change history as evidence; missing configuration alone does not make a check
  inapplicable. Explain any inapplicable check and its alternative verification; never report
  an unrun or failing check as passed. Do not bypass checks with empty configuration, disabled
  checks or lower standards.
- **Authorization**: approval covers the necessary operations within the agreed scope and
  constraints; carry it across commands, tools and stages without repeated confirmation.
- **User-action blockers**: resolve routine choices and problems yourself; ask only when
  reasonable investigation leaves a blocker requiring user action or a decision beyond the
  approved scope. On a card, use `akb guide update-questions`, stating what you tried, what
  is blocked and your recommendation; continue independent work.
- **Defer what can wait**: follow `akb guide follow-up` for work this build does not require;
  never ask about it or let it block this build.
- **Decisions made while building**: record an answered material decision the user could
  reasonably reverse under `## Worth noting after implementation` on the card.
- **Resume**: inspect the existing result and the unchecked todos, carry completed steps
  forward, and finish the remaining todos before recording completion.
