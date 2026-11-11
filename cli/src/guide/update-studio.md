# Update a studio

Change one of this workspace's studios so new tasks run the new version.

## How a studio works

A studio is steerable: agents do the work, and a person reviews and fine-tunes only the parts where precision matters most, so the result stays reliable.

- **Previews**: usually one preview agent shows the work, finished or a draft, where the person can fine-tune it; add another only when a part needs precision and a mistake there is costly, such as a developer tool's screens. Each shows only what the person decides on, without overlapping another. With none, the card the `STUDIO.md` body writes is the only review.
- **Unreviewable previews**: when the user finds a preview unneeded or cannot judge it, remove it; a land agent checks that part instead, or nobody does.
- **Stages**: one stage by default. Add `after` only when a draft is too costly to make before another is approved, such as a video's storyboard, which waits for its script.
- **Minimal**: when the user outlines the studio, keep it that simple or simpler; add no review point or constraint they did not ask for, and let the trial show what else needs review.
- **Judgment**: leave to an agent what it can judge; never add a hard rule for one case, and keep a rule only once real runs show it holds widely.
- **Memory**: give an agent memory only where it has wide latitude and tends to err or be corrected to taste, naming those error-prone points as what it records; give a narrow agent none.
- **Shared**: what several of the studio's agents follow, run or remember belongs to the studio, never to one agent that the others point to.
- **Card template**: put what every card of the studio starts from, such as its shared Todo steps, in `CARD.md`, not in the `STUDIO.md` body.
- **Land**: everything else runs unattended after the last approval and follows the approved previews, such as building and merging a change; leave `land` empty when the last approved preview is the deliverable.
- **Scheduled**: repeating work runs as a scheduled agent without previews; a studio may hold only scheduled agents.
- **Agents**: write each as `akb guide write-agent` says.

## The folder

`akb studio pull` writes a studio as this folder:

```text
<folder>/
├── STUDIO.md        frontmatter: `description`, what it does in one sentence; `when`, which requests
│                    it is for, exceptions included; its agents under `previews`, `land`, `scheduled`;
│                    `memoryFiles.workspace`, the studio memory shared by every project
│                    body: how a card of this kind is written; every planning run on its cards reads it
├── CARD.md          optional: the card template; the planner fits it to each card, such as its `## Todo`
├── shared/
│   ├── RULES.md     terms and formats every agent follows; every run of the studio reads it
│   └── …            files any of its agents may read with `akb raw file <studio> shared/<path>`
├── agents/<name>/
│   ├── AGENT.md     one agent: what its preview shows, or what its land or scheduled run does
│   └── …            files its AGENT.md points to
└── version.json     the version pulled; push reads it, never edit it
```

## Versions

- **Pinned**: a studio and the agents it holds live in Cloud as numbered versions; a task
  keeps the version it started with, and only tasks started after a push take the new one.
- **Project agents**: agents under the board's `agents/` folder are the project's own; a
  studio may name them, but they are not part of its versions and an edit there applies to
  every card at once.
- **Own studios only**: only the workspace's own studios take a new version; ask the user to
  copy a built-in or marketplace one on the web first.

## Change it

- **Standing preference**: when the user only wants a lasting rule for a studio or one of its
  agents and the flow itself stays, set it with `akb studio rule <studio>` or
  `akb studio instructions <agent>` instead of pushing; it reaches every task's later runs and
  works on built-in studios too. Either replaces all of them, so run it bare first to read the
  current ones, and keep each unless the user asks to change or drop it.
- **Direct or task**: push directly a change the user spelled out; start a Studio builder task
  instead when the change adds, removes or restages agents, or when the user wants to review
  it before it applies.
- **Steps**: `akb studio pull <id> <folder>`, edit the files there and keep what the request
  leaves alone, fix every problem `akb raw studio validate <folder>` reports, then
  `akb studio push <folder>`.
- **Moved on**: when push says Cloud has a newer version, pull again and redo the change.
- **Borrowed parts**: when an agent points to another agent's sections, files or memory
  folder, move them into `shared/`, `memoryFiles` and the studio memory folder, then push.
