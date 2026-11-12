# Reply approval

Card Chat's `akb task approve` and `akb raw card approve/implement` register approval for the current reply. The command reports acceptance; only a successful reply with synchronized card and assets can advance the current review stage. Stops, failures, intervening changes and lost access cancel the request. Normal handoff uses the existing task status.

The public `POST /v1/tasks/{task}/decisions` contract is in [OpenAPI](../../cloud/openapi.json). Pass `decision: "approve"`, `review_revision`, `after_reply` (the current reply UUID) and `card_version`. First acceptance returns 202; retries return the same request's current status. Omit `after_reply` for ordinary approval.

Runner uses `POST /v1/runner/jobs/{job}/approve` with `{machineId, fields: {card_version, review_revision, comment?}}`, or `{machineId, cancel: true}`. Cloud checks the held job and authorizes its chat author. A successful finish carries `report.replyApprovalSynced: true` only after all uploads succeed. Older Runners cannot commit deferred requests without that proof.

See [deployment and rollback](../deploy.md#reply-approval-handoff).
