# Resolve board content conflicts

- **Read**: use `akb raw conflict list`, then `akb raw conflict show <id>` to read the saved three-way versions, current local work and affected batch; follow the files' ownership rules.
- **Decide**: reconcile the intended meaning using the task and relevant decisions; use `akb guide update-questions` only for a material choice the evidence cannot settle.
- **Submit**: write a temporary JSON resolution with one `path` and final `content` for each conflicting file, using `null` for deletion, then run `akb raw conflict resolve <id> --expect <revision> --file <path>` with the revision just read.
- **Changed facts**: if the command reports changed versions, read the conflict again and reconsider the result; do not refresh away local work or blindly repeat the old resolution.
- **Continue**: after confirmed synchronization, continue the original work.
- **Blocked**: when you cannot resolve a conflict or confirm its submission, preserve the content, draft, ID, reason and next check; report the obstacle without claiming success, and honor a user stop.
