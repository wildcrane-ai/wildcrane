# Update a workflow

Change one of this workspace's workflows so new tasks run the new version.

## How a workflow works

A workflow is steerable: agents do the work, and a person reviews and fine-tunes only the parts where precision matters most, so the result stays reliable.

- **Previews**: usually one preview agent shows the first draft; add another only when a part needs precision and a mistake there is costly, such as a developer tool's screens. Each shows only what the person decides on, without overlapping another. With none, the card the `WORKFLOW.md` body writes is the only review.
- **Unreviewable previews**: when the user finds a preview unneeded or cannot judge it, remove it; a land agent checks that part instead, or nobody does.
- **Stages**: one stage by default. Add `after` only when a draft is too costly to make before another is approved, such as a video's storyboard, which waits for its script.
- **Minimal**: when the user outlines the workflow, keep it that simple or simpler; add no review point or constraint they did not ask for, and let the trial show what else needs review.
- **Judgment**: leave to an agent what it can judge; never add a hard rule for one case, and keep a rule only once real runs show it holds widely.
- **Memory**: give an agent memory only where it has wide latitude and tends to err or be corrected to taste, naming those error-prone points as what it records; give a narrow agent none.
- **Land**: everything else runs unattended after the last approval and follows the approved drafts, such as building and merging a change; leave `land` empty when the last approved preview is the deliverable.
- **Scheduled**: repeating work runs as a scheduled agent without previews; a workflow may hold only scheduled agents.
- **`WORKFLOW.md`**: list its agents under `previews`, `land` and `scheduled`; `description` says in one sentence what it does; `when` tells an agent which requests it is for, exceptions included; the body is how a card of this kind is written.
- **Agents**: write each as `akb guide write-agent` says.

## Versions

- **Pinned**: a workflow and the agents it holds live in Cloud as numbered versions; a task
  keeps the version it started with, and only tasks started after a push take the new one.
- **Project agents**: agents under the board's `agents/` folder are the project's own; a
  workflow may name them, but they are not part of its versions and an edit there applies to
  every card at once.
- **Own workflows only**: only the workspace's own workflows take a new version; ask the user to
  copy a built-in or marketplace one on the web first.

## Change it

- **Standing preference**: when the user only wants a lasting rule for a workflow or one of its
  agents and the flow itself stays, set it with `akb workflow rule <workflow>` or
  `akb workflow instructions <agent>` instead of pushing; it reaches every task's later runs and
  works on built-in workflows too. Either replaces all of them, so run it bare first to read the
  current ones, and keep each unless the user asks to change or drop it.
- **Direct or task**: push directly a change the user spelled out; start a Workflow builder task
  instead when the change adds, removes or restages agents, or when the user wants to see it
  work before it applies.
- **Steps**: `akb workflow pull <id> <folder>`, edit the files there and keep what the request
  leaves alone, fix every problem `akb raw workflow validate <folder>` reports, then
  `akb workflow push <folder>`.
- **Moved on**: when push says Cloud has a newer version, pull again and redo the change.
