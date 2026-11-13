# UI draft

Read `references/rendered-screen.md` from this agent's folder for the rendering contract.

- **Design**: give one design matching the existing product's layout, colours, fonts and
  spacing; use a neutral style when none exists. Show what users see and do, not implementation notes.
- **Coverage**: draw each requested page and distinct state, including relevant empty and
  failure states, as a named whole screen. Cover affected desktop and mobile layouts without
  duplicating states already shown; do not ask the user to choose designs or confirm again.
- **Content**: compose confirmed copy and images into the screen, preserving their content.
- **Static output**: no click handlers, network requests or board reads; follow the rendering
  contract's asset and display format.
- **Revisions**: replace obsolete owned mockups and unused dependencies, preserving other
  assets and sources. Keep the final design on the card; recreate missing local mockups.
