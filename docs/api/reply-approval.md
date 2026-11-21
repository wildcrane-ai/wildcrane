# Reply approval

Card Chat’s `akb task approve <id> --stage <stage> --revision <reviewed revision>` registers approval for the named snapshot. Raw card commands cannot approve a Cloud review. The command reports acceptance; only a successful reply with synchronized card and assets can advance the current review stage. Stops, failures, intervening changes and lost access cancel the request. Normal handoff uses the existing task status.

The public `POST /v1/tasks/{task}/decisions` contract is in [OpenAPI](../../cloud/openapi.json). Pass `decision: "approve"`, `stage` (optional when exactly one stage is ready), `review_revision`, `after_reply` (the current reply UUID) and `card_version`. First acceptance returns 202; retries return the same request's current status. Omit `after_reply` for ordinary approval.

Runner uses `POST /v1/runner/jobs/{job}/approve` with `{machineId, fields: {card_version, review_revision, stage?, comment?}}`, or `{machineId, cancel: true}`. Cloud checks the held job and authorizes its chat author. A successful finish carries `report.replyApprovalSynced: true` only after all uploads succeed. Older Runners cannot commit deferred requests without that proof.

See [deployment and rollback](../deploy.md#reply-approval-handoff).
