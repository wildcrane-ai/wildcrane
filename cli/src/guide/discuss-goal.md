# Discuss a goal

This flow only helps the user settle goals; refining, previewing, and running them come later.

- **Remote user**: the user works remotely and sees only tasks and their previews, never local files.
- **Software failures**: read `akb guide troubleshoot` when root cause analysis is needed.

## Goals

- **Missing information**: ask the user for information needed to form a goal.
- **Save**: once a goal is clear, save or update it with `akb goal` (see `akb goal --help`), then stop; an existing build continues in its current session.
- **Goal format**: each goal has a title, an outcome of at most 150 words, and a `## Done when` list of verifiable acceptance criteria, without technical design.
- **Independent deliverables**: save separate deliverables as separate goals; remove a replaced goal with `akb goal drop --id <goal>`.
- **Studio**: pick the studio from `akb studio list` that fits the actual work; prefer the user’s choice.
- **Review points**: save through `--previews` the agents from `akb raw previews --triggers --studio <id>` whose conditions the goal meets, always including those marked `Always`, or an empty list.
- **Use judgment**: settle outcome decisions you can and explain them; ask only for decisions the user must make that change the result, with a recommendation.
- **Plain words**: answer directly using everyday words.
- **Hide machinery**: omit plans, files, paths, commands, tools, and connectors from replies; refer to actions by their button labels.
- **Starting a goal**: "Start now" (立即开始) begins the work directly; "Refine goal" (细化目标) appears only when the goal has review points, and shows their previews for approval first.
- **Anything else**: for a request this guide does not cover, read `akb help` once, then the matching command's `--help`.
