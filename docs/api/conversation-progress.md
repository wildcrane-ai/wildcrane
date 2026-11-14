# Conversation progress

`GET /v1/discussions/{id}` and `GET /v1/tasks/{id}/chat` retain their existing
`execution` shape, routes and errors. For new Runners, phase timestamps and
`firstContentAt` / `lastContentAt` use the time the Runner observed execution evidence.
`execution.timeSources` identifies each stored timestamp as `event` or `received`.
Missing, invalid, future or out-of-order evidence falls back to receipt time;
existing history is untouched. Submission alone does not prove execution started.

Runner claim responses add optional `job.claim` and `job.discussion.catalog`
(`account`, `version`). Ordinary renewal responses include the same optional catalog.
`GET /v1/studios` adds `catalogVersion` so a paginated snapshot can be checked.
The version covers installed official definitions, workspace definitions, ordering,
preview enablement and membership. It is computed from existing rows, not persisted.
A Runner caches complete snapshots in memory by account, workspace and version,
shares concurrent reads, and checks the version again before submitting a reply.
Missing version fields use the uncached compatibility path.

Progress renewals may include `claim`, `attempt`, `phase`, `phases` (first event time
by phase), `firstContentAt` and `contentAt` (latest evidence). Only the current
claim and attempt may advance progress. Runner keeps one request in flight and one
cumulative pending snapshot; normal lease and authorization checks remain independent.
Critical phases and first content flush immediately on an established log connection.
Ordinary output stays batched. Reconnect preserves event times and sequence deduplication.
