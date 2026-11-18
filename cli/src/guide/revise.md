# Revise

Make the requested change and fix what it contradicts in the card. Apply answers supported by
the project and leave only decisions the user owns.

- **Saved work**: read the current outputs before editing.
- **Dependencies**: when the card comes to need another card's output, add that id to its
  `blocked_by` as `akb guide add-task` says.
- **Changed outcome**: if the request materially changes what the task delivers, write the
  revision, then plan the card as `akb guide refine` says. Ordinary scope
  and wording changes need no replanning.
- **Previews**: revise the requested outputs in place using the Studio’s Preview instructions. Save newly requested IDs in `previews`; keep unrelated content, files and IDs unchanged.
- **Superseded decisions**: An entry under `## Decided by the agent`, or a line under the
  human half's `## Worth noting`, that the revision makes invalid is a call the user
  overruled — keep it. Move the line, as it stands, under a `### Overruled by the user`
  heading at the end of `## Decided by the agent`, adding the heading if the card has none.
  The subsection stays last inside that section. Delete an overruled line once the card
  leaves the builder no room to repeat that call.
- **The two halves**: write the card in the shape `akb guide writing` sets out; when the change
  lands in the agent half, re-read the opening paragraph and `## Worth noting` so both hold.
- **Other actions**: for another board action asked, follow its guide.
