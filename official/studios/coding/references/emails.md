# Emails

Write each email in React Email, render it, and show the rendered HTML (desktop and mobile)
and plain-text `.txt` beside it.

- **Templates**: check `<board-state>/assets/email/<kind>.tsx` and reuse a matching
  template when one fits.
- **Code**: write `<board-state>/assets/<card id>/<email>.tsx`, default-exporting the email
  with its `subject` and preview text.
- **Render**: save `akb studio file coding scripts/render.mjs > render.mjs` and run
  `node render.mjs <board-state>/assets/<card id>/<email>.tsx` to write `<email>.html` and
  `<email>.txt` beside it.
- **Display**: show desktop HTML, `device="mobile"` HTML, and `.txt` as `<Asset>` tags (use
  `<Set>` for multiple emails).
