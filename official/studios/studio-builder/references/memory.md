# Preview Memory

Use a short memory policy only when confirmed rules, habits, or preferences improve future work.

- **Location**: use `previews/<studio-id>/<preview-id>/{project,workspace}/` under the supplied memory root, with the Studio and Preview's stable IDs.
- **Reading**: read relevant files on demand and leave full memory out of task context. If saved memory conflicts with the user's current request or task facts, follow the current request and task facts. Treat `.conflicts/` in either scope as unresolved sources.
- **Retention**: ordinary tasks only read memory. Conversation review retains explicitly confirmed lasting rules, habits, preferences, and corrections. Record them in `project/` unless the user explicitly confirms cross-project reuse in the same workspace.

For a Preview with the ID `draft`, replace `<studio-id>` with the target Studio's stable ID:

```markdown
<Preview id="draft">
Show the draft as an Asset.

Read relevant files on demand from `previews/<studio-id>/draft/{project,workspace}/`. If saved memory conflicts with the user's current request or task facts, follow the current request and task facts. Treat `.conflicts/` as unresolved sources.
During conversation review, retain only explicitly confirmed lasting feedback in `project/`. Use `workspace/` only when the user explicitly confirms reuse across projects in this workspace.
</Preview>
```
