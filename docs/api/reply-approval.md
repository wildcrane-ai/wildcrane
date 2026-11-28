# Reply approval

Card Chat’s `akb task approve <id> [--stage <stage>] [--comment <text>]` registers approval for the snapshot held by the reply. Specify the stage when several approvals are pending. The receipt stays pending until the reply finishes and synchronizes its card and assets. If the target changes, review it again and ask in a new reply.

The public `POST /v1/tasks/{task}/decisions` contract is in [OpenAPI](../../cloud/openapi.json). Pass `decision: "approve"`, `stage` (optional when exactly one stage is ready), `review_revision`, `after_reply` (the current reply UUID) and `card_version`. First acceptance returns 202; retries return the same request's current status. Omit `after_reply` for ordinary approval.

Runner uses `POST /v1/runner/jobs/{job}/approve` with `{machineId, fields: {card_version, review_revision, stage?, comment?}}`, or `{machineId, cancel: true}`. Cloud checks the held job, chat author, card version and target evidence. Registration and commit reject a target newer than the review baseline recorded when the reply was queued. Runner sends `report.replyApprovalSynced: true` after successful uploads. Stops, failures, intervening changes and lost access cancel the request.

See [deployment and rollback](../deploy.md#reply-approval-handoff).
