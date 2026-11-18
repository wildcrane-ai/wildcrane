# Prune the memory

Prune Wild Crane memory under `docs/kanban/memory/`, including module and Studio Preview
folders (for both built-in and user Studios), while leaving external memory untouched.
Project records remain relevant even when no Preview uses memory.

- **Keep**: retain useful user preferences, habits, explicit corrections and project-specific decisions that current sources cannot supply.
- **Drop**: remove common knowledge, generic procedures, obsolete model workarounds, duplicates and superseded notes; check current sources when validity is unclear.
- **Condense**: merge related notes into short takeaways without widening their scope; empty memory is a valid result.
- **Scope**: preserve project and shared boundaries, judging a note's value independently of whether its former agent still exists.

## Project records

- **rejected.md**: keep live user rejections, reasons and source IDs in their existing format; remove withdrawn rejections and items that merely shipped.
- **redesign.md**: keep applicable design lessons; remove lessons that are obsolete, common knowledge or already covered by current rules.
- **decisions.md**: keep live user decisions; remove superseded decisions and those fully covered by current documentation.
- **project.md**: the existing `describe-project` flow maintains a concise description of what ships today, removing obsolete features and plans; leave its rewrite to that flow.
- **readme.md**: keep shipped outcomes not covered by current documentation; replace an entry with a link only after checking that the documentation covers it.

Leave user-authored `MEMORY.md` rules unchanged and preserve references needed to trace or
withdraw retained notes.
