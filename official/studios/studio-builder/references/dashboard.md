# Deliver an approved Dashboard

1. **Recover the approved input.** Run `akb task show <card>` and open the manifest under
   **Approved inputs**. Find the approved `dashboard` section and its pinned TSX, styles, modules,
   and assets. Copy those versions into a separate build folder using their original relative
   paths. Restore imports if the staged copies use different filenames. Resolve missing pins
   before building.
2. **Build the page.** Use the project's static frontend build or a small browser entry that
   mounts the approved TSX with React. Bundle the client-side behavior for the reviewed states
   while preserving their layout, styling, and content. Compile any Tailwind styles and keep
   the approved images and fonts. Use a separate output directory with `index.html` at its
   root and all runtime files inside it. Make script, CSS, font, and image URLs relative to
   the deployed page or stylesheet.
3. **Verify the output.** Serve the output directory over local HTTP under a URL prefix.
   Compare desktop (1280×800) and mobile (393×852) with the approved Preview. Check for
   failed resources and exercise the approved interactions.
4. **Publish to the target.** Run `akb studio dashboard publish <studio> <dir>` with the target
   Studio ID and the output directory. Record the returned URL on the task. Use the Studio
   definition save and publication procedure only when the task changes the definition.
