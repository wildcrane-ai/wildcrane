# Official studios

Each `studios/<studio>/` holds its `STUDIO.md`, `agents/<agent>/` definitions and resources, and shared files. Nothing ships this folder: Cloud serves it.

- **Publish**: every Cloud deploy's `npm run migrate` publishes it. A studio whose files changed becomes its new version; new tasks take it.
- **Chinese name**: `names: zh` in each `STUDIO.md`.
- **Test**: `node --test official/test/*.test.ts`; akb's tests read this folder through `AI4KANBAN_STUDIOS`.

- **UI checker**: Coding and Studio Builder ship their own copies of `skills/ui-mockup/`. Regenerate and sync them from `shared/skills/` in the source repository.
