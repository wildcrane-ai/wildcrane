// The parts of `akb help` no flag can carry.
//
// What every command takes is declared on the command (lib/cli/agent.ts, lib/cli/board.ts)
// and the help is what that declaration says — there is no second copy of it here. What is
// left is the guidance a table of options cannot hold: when to print a flow instead of
// starting a run, and what a delivery is.
//
// Each block is attached to the command it is about, never to the root — `akb help` is
// Commander's own list and stays that short.

export const HELP_AFTER = {
  /** Under every flow: print it, or run it. The one choice each of them has. */
  flow: `
Print it, or run it
  --print     print the flow to follow in the current session, filled in for this board:
              the card's own path, the steps it has left, the memory file its modules point
              at, the flows the job is done by in full, and the
              command that closes the job — because nothing is watching you finish.
  (no flag)   start a separate session with its own context.

  Inside a task session, board actions print their flows. Prepare requested Previews there.
`,

  /** Under `delivery`: what one is, which no verb of it says on its own. */
  deliveries: (program: string): string => `
What a delivery is
  A delivery freezes the approved requirements. The task session records the result with
  \`delivery complete\` and archives the card.
  The builder manages its branch, worktree, checks and merge. File studios deliver their
  recorded outputs in the authorized directory. A successful run alone does not finish a delivery.
  \`cancel\` ends it and preserves files. \`resume\` continues unfinished work.

`,
}
