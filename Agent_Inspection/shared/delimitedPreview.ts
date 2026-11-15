/** Bounded CSV/TSV preview, including quoted delimiters, escaped quotes and multiline cells. */
export function delimitedPreview(text: string, separator = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const pushCell = () => { if (row.length < 30) row.push(cell); cell = ''; };
  for (let index = 0; index < text.length && rows.length < 101; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = !quoted;
    } else if (char === separator && !quoted) pushCell();
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      pushCell(); rows.push(row); row = [];
    } else cell += char;
  }
  if ((cell || row.length) && rows.length < 101) { pushCell(); rows.push(row); }
  return rows;
}
