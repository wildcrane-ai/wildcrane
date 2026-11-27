# Emails

Write each email in React Email, render it, and show the rendered HTML (desktop and mobile)
and plain-text `.txt` beside it.

- **Templates**: reuse a matching template from `email/` beside the task's Asset folder.
- **Code**: save `<email>.tsx` in the task's Asset folder and default-export the email
  with its `subject` and preview text.
- **Render**: save `akb studio file coding scripts/render.mjs > render.mjs` and run
  `node render.mjs` with the full path to the saved `.tsx` file. The HTML and text are written beside it.
- **Display**: show `asset:<email>.html` as desktop and mobile Assets and `asset:<email>.txt` as a text Asset.
  Use a Set for multiple emails.
