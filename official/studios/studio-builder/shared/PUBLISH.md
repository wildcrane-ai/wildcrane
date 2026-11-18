# Publish a studio

Use these commands after approval, or within an explicit instruction to apply the change now.
Keep the reviewed files, base version and publication request ID with the card’s assets.

- **Restore**: if the draft folder is missing, unpack the approved ZIP into an empty folder.
- **Validate**: run `akb raw studio validate <folder> --json` and match its fingerprint to the approved `<Studio>` review; any difference returns to review.
- **Create**: for a new studio, run `akb studio create <folder> --request-id <id>`; use `--workspace <workspace>` for a user-specified target.
- **Update**: for an existing studio, run `akb studio push <folder> --request-id <id>`;
  keep the `version.json` supplied by pull unchanged before publication.
- **Retry**: reuse the same request ID and payload after a timeout; a changed publication uses
  a new request ID. Verify the returned studio ID and version before recording delivery.
- **Conflict**: when the base version is stale or missing, refresh from Cloud into an empty
  folder, merge both sets of changes and update the reviewed differences; ask only about unresolved semantic conflicts.

Publishing changes the workspace’s shared studio. Existing tasks retain their pinned version.
