# Update a studio

- **Studio files**: follow `akb guide add-task` to create a card with `--studio studio-builder`
  for a new studio or a change to an existing studio.
- **Current draft**: a correction to the current card’s deliverable follows `akb guide card-chat`.
- **User rules**: for an explicit request to read or change attached rules, use
  `akb studio rule <studio>` or `akb studio instructions <agent>`; bare reads,
  `--text` or `--file` replaces all, and empty text clears. Read before changing and keep
  what the request leaves alone. These commands change attached rules, not `AGENT.md`.
