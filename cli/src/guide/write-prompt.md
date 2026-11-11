# Write a prompt

How the text of any prompt reads: an agent, a skill, a guide, or a prompt embedded in code.

- **Only a real gap**: change a prompt only where it lacks an instruction it needs; reuse
  instructions that remain sufficient, and trim what is there while you add.
- **Natural language only**: never write code, pseudocode, or a programmatic wrapper,
  including code that builds, picks, or controls a prompt. State conditions, branches, and
  order as plain instructions.
- **Short and generic**: one generic sentence per rule, said once; no obvious explanations,
  defensive clauses, or downstream duties.
- **Scannable Markdown**: keep headings and lists where they help; bullets read
  `- **bold title**: one liner`.
- **Professional and comprehensible**: plain, clear language.
