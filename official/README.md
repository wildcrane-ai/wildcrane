# Official studios

The built-in studios and the agents they run (#409). Nothing ships this folder: Cloud serves it.

- **Publish**: every Cloud deploy's `npm run migrate` publishes it. A studio whose files changed becomes its new version; new tasks take it.
- **Chinese name**: `names: zh` in each `STUDIO.md`.
- **Test**: `node --test official/test/*.test.ts`; akb's tests read this folder through `AI4KANBAN_STUDIOS`.
