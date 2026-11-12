# Publish a studio

Use these commands after approval, or within an explicit instruction to apply the change now.
Keep the reviewed files, target, base version and publication request ID with the card’s assets.

- **Validate**: run `akb raw studio validate <folder> --json` and compare its fingerprint with the reviewed one; any difference returns to review.
- **Create**: for a new studio, run `akb studio create <folder> --request-id <id> --workspace <workspace>`.
- **Update**: for an existing studio, run `akb studio push <folder> --request-id <id>`;
  keep the `version.json` supplied by pull unchanged before publication.
- **Retry**: reuse the same request ID and payload after a timeout; a changed publication uses
  a new request ID. Verify the returned studio ID and version before recording delivery.
- **Conflict**: when the base version is stale or missing, refresh from Cloud into an empty
  folder, reapply the requested changes and return the updated differences for review.

Publishing changes the workspace’s shared studio. Existing tasks retain their pinned version.
