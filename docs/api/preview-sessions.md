# Preview sessions

`AGENT.md` may declare `akb.session: new` to recommend a separate session. The calling agent
chooses either mode, including when the preview has its own runtime:

```sh
akb raw previews ui-designer 738 --print
akb raw previews ui-designer 738
```

`--print` enters the selected role in the current task session and prints its instructions.
Omitting it starts a separate session, queued after the caller when inside a board run.
Planning runs, task chats and external sessions use the same stage commands:

```sh
akb raw previews ui-designer 738 --stages ui-draft
akb raw previews ui-designer 738 --revise-from ui-draft
akb raw previews ui-designer 738 --submit --stage ui-draft
```

Enter the role before working on stages. Each task, role and execution has its own baseline;
re-entering the same request and submitting again preserve saved versions. A new revision
retains saved work and asks for the earliest affected stage, preserving its confirmed prefix.
Old executions, other tasks and unselected roles cannot submit. User confirmation still gates
later stages. Existing command parameters and JSON results are unchanged.
