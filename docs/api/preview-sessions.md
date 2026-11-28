# Preview outputs

A task session prepares the requested outputs using the Preview definitions in its bound
Studio. Use `akb studio previews --studio <id>` to read the IDs and instructions.

Use `akb task review <task>` to read the review plan and pending approvals. Sync the card and
assets before reporting an assigned stage done. For a review rule that calls for approval, use
`akb task review <task> --request-approval <question> --preview <id>`.

In Card Chat, use `akb task approve` only at the user's explicit request.
