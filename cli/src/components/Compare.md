# Compare

Show two files with `<Compare a="<src>" b="<src>" label="..." a-label="..." b-label="..." />` alone in a paragraph; never render a side-by-side file for it. Inline and fenced examples remain text.

- **Sides**: either side may be anything an Asset shows, of different kinds, but not another compare; two images or two videos share one viewer, any other pair shows as two Assets.
- **Video shots**: add `shots="<src>"`, a JSON list of `{ "id": "S1", "start": 0, "end": 2.25, "name": "..." }` covering video A in order, or a storyboard of A.
- **Storyboard pairing**: beside video A, B may be a storyboard of it; it shows the shot with the id A is on, beside that shot of a storyboard `shots`.
- **Data contract**: follow the producing agent's file contract and validator for storyboards.
