# Write a card

A card has a **human half** for review and a folded **agent half** for implementation.
Use this order and keep the English section titles and empty scaffold sections:

```text
<One short paragraph: the problem and the intended result.>

## Worth noting              <- user's answers first, then material decisions; empty if none
- **<decision>**: <chosen behavior and main cost in one sentence>

## Worth noting after implementation
- **<decision>**: <chosen behavior and main cost in one sentence>
                             <- settled by the build; omit when empty; no logs or open questions

<Preview id="<id>">         <- requested deliverable
<result Markdown and assets>
</Preview>

<!-- agent -->               <- folded content starts here

## Scope                     <- requirements, not rationale
### Done when                <- acceptance checklist, when supplied
- [ ] <observable result>

## Todo                      <- implementation only; finish planning before writing steps
- [ ] <one build step>

## Decided by the agent      <- other decisions and non-obvious findings the build needs
- **<decision>**: <answer and required action>
### Overruled by the user    <- superseded decisions, always last
```

- **Decisions**: use the material-decision test in `akb guide update-questions` for Worth noting;
  merge entries governed by one policy and keep only the decision and its main cost.
- **Delivery boundary**: Worth noting after implementation never changes approved scope or
  blocks an ongoing delivery; the build must fix deviations or refer them to the user.
- **Preview sections**: use matching Preview tags and a stable Studio ID; keep the ID when revising.
  The app supplies localized titles and icons. Group files of one deliverable with Set.
- **Previews**: follow "Task context" in `akb guide board` before preparing or revising a Preview.
- **Preview presentation**: before submitting a Preview, check that it shows the deliverable directly
  and includes only brief surrounding text needed for review or requested by the user, stated once.
- **Preserve work**: leave checked todos and supplied Done when checklists unchanged; append a
  todo to reverse completed work, and move user-overruled decisions to Overruled by the user
  until the card leaves no room to repeat them.
- **Writing**: write clear behavior and necessary tradeoffs for a fresh reader, keep the human
  half self-contained, and state each fact once.
- **Agent half**: keep only implementation-critical information not stated elsewhere; omit
  process logs and routine implementation planning, and leave unneeded sections empty.
- **Frontmatter**: never edit frontmatter by hand; use `akb task update` or `akb task update-questions`.
- **Validate**: run `akb task validate <id>` after edits and fix every reported file and line.
