type Range = [start: number, end: number];

function* inlineCode(text: string, start: number, end: number): Generator<Range, void> {
  const prose = text.slice(start, end);
  const runs = [...prose.matchAll(/`+/g)];
  const next = new Map<number, number>();
  const closers = new Array<number | undefined>(runs.length);
  // Index exact-length closers so unmatched openers leave the rest of the paragraph visible.
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    let backslashes = 0;
    while (prose[run.index - backslashes - 1] === '\\') backslashes++;
    const escaped = backslashes % 2;
    closers[i] = next.get(run[0].length - escaped);
    next.set(run[0].length, i);
  }
  for (let i = 0; i < runs.length; i++) {
    const closer = closers[i];
    if (closer === undefined) continue;
    const close = runs[closer]!;
    yield [start + runs[i]!.index, start + close.index + close[0].length];
    i = closer;
  }
}

export function* markdownCodeRanges(text: string): Generator<Range, void> {
  let proseStart = 0;
  let fence: { marker: string; start: number } | undefined;
  for (const line of text.matchAll(/[^\r\n]*(?:\r\n?|\n)|[^\r\n]+$/g)) {
    const [full] = line;
    const [, marker, info] = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(full) ?? [];
    if (fence) {
      if (marker?.startsWith(fence.marker) && /^[ \t]*$/.test(info!)) {
        proseStart = line.index + full.length;
        yield [fence.start, proseStart];
        fence = undefined;
      }
    } else if (marker && (marker[0] === '~' || !info!.includes('`'))) {
      yield* inlineCode(text, proseStart, line.index);
      fence = { marker, start: line.index };
    } else if (!full.trim()) {
      yield* inlineCode(text, proseStart, line.index);
      proseStart = line.index + full.length;
    }
  }
  if (fence) yield [fence.start, text.length];
  else yield* inlineCode(text, proseStart, text.length);
}
