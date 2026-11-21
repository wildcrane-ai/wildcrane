# Implement the approved requirements

Build the approved requirements without reopening settled decisions or unrelated questions; without a card, create none.

For Git deliveries, adapt the approved work to the current target branch and preserve its
behavior and removals unless the task's core intent requires changing them. Stop the
affected work and use `akb guide update-questions` only if those changes conflict with the
task's core intent.

Do not push, publish or deploy.

Once a task meets its Studio's delivery conditions, follow `akb guide archive` to record
delivery completion before ending the run.

- **Verification**: run required and minimal representative checks, reuse valid results, distinguish defects from environment or tool limits, stop retries that add no evidence, and finish when acceptance is proven.
- **Authorization**: carry approval for necessary in-scope operations across tools and stages without asking again.
- **Blockers**: resolve routine problems and use `akb guide update-questions` only for user-action blockers or out-of-scope decisions, stating attempts, impact and recommendation while continuing independent work.
- **Defer**: follow `akb guide follow-up` for unrelated work and keep it from blocking delivery.
- **Decisions**: record material, reversible build decisions under `## Worth noting after implementation`.
