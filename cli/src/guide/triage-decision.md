# Decide whether work should proceed

Use these rules for follow-ups, reflection, and incoming triage items. Read the relevant project files and decisions before deciding.

- **Admission**: for agent-proposed follow-ups, read `allowedFollowUps` in the source Studio's `STUDIO.md`; skip absent or blank rules and work outside them. For incoming suggestions, judge against the project's stated purpose and decisions.
- **Evidence**: verify the requested outcome against current behavior or deliverables; cite evidence and skip resolved work.
- **Prior decisions**: skip work turned down in `docs/kanban/memory/agents/planner/rejected.md` or its module folders, and calls reversed in `docs/kanban/memory/agents/` `redesign.md` files or a source card's `Overruled by the user`.
- **Coverage**: compare scope and acceptance criteria with open and queued tasks, other pending triage items and this batch; skip fully covered outcomes and name what covers them. Partial overlap or a similar title is insufficient.
- **Scope**: use an existing workflow when it meets the need; otherwise retain only the smallest change supported by evidence, without optional interactions or artifacts. Leave incoming items for review when only a narrower proposal is supported.
- **User decisions**: leave unresolved product direction, pricing, external commitments, and material trade-offs for the user; ordinary implementation choices belong to the agent.
- **Result**: choose `skip` for work ruled out above, `review` for unresolved decisions or insufficient evidence, and `plan` when the full scope is supported and no user decision remains. State the evidence or unresolved question.
- **Studio**: retain the bound Studio; otherwise choose an available Studio whose scope fits the work, or leave the item for review when none fits.
