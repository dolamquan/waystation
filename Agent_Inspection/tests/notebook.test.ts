import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline } from '../web/src/components/consoles/markdownBlocks.ts';
import { MAX_OUTPUT_CHARS, NotebookError, parseNotebook, stripAnsi } from '../web/src/components/consoles/notebook.ts';

const notebook = (cells: unknown[], metadata: unknown = { kernelspec: { language: 'python' } }) => JSON.stringify({ nbformat: 4, metadata, cells });

describe('parseNotebook', () => {
  it('reads markdown and code cells, joining sources stored as lists of lines', () => {
    const parsed = parseNotebook(notebook([
      { cell_type: 'markdown', source: ['# Title\n', 'Some *text*'] },
      { cell_type: 'code', execution_count: 3, source: 'x = 1\nx', outputs: [{ output_type: 'execute_result', data: { 'text/plain': ['1'] } }] },
      { cell_type: 'raw', source: 'raw text' },
    ]));
    expect(parsed.language).toBe('python');
    expect(parsed.cells.map((cell) => [cell.kind, cell.source])).toEqual([['markdown', '# Title\nSome *text*'], ['code', 'x = 1\nx'], ['raw', 'raw text']]);
    expect(parsed.cells[1]).toMatchObject({ count: 3, outputs: [{ kind: 'text', text: '1', tone: 'result' }] });
  });
  it('shows images, prefers them over text, and shows HTML-only output as a note, never as markup', () => {
    const parsed = parseNotebook(notebook([{ cell_type: 'code', source: '', outputs: [
      { output_type: 'display_data', data: { 'image/png': 'iVBOR\nw0K', 'text/plain': '<Figure>' } },
      { output_type: 'display_data', data: { 'text/html': '<script>alert(1)</script>' } },
      { output_type: 'display_data', data: { 'image/svg+xml': ['<svg xmlns="http://www.w3.org/2000/svg"/>'] } },
    ] }]));
    const outputs = parsed.cells[0]!.outputs;
    expect(outputs[0]).toEqual({ kind: 'image', mime: 'image/png', base64: 'iVBORw0K' });
    expect(outputs[1]).toEqual({ kind: 'text', text: '(HTML output, not shown here)', tone: 'result' });
    expect(outputs[2]).toMatchObject({ kind: 'image', mime: 'image/svg+xml' });
    expect(atob((outputs[2] as { base64: string }).base64)).toContain('<svg');
  });
  it('reads streams and errors, without terminal colour codes, and caps long output', () => {
    const parsed = parseNotebook(notebook([{ cell_type: 'code', source: '', outputs: [
      { output_type: 'stream', name: 'stderr', text: ['warn\n'] },
      { output_type: 'error', ename: 'ValueError', evalue: 'bad', traceback: ['\u001b[31mValueError\u001b[0m: bad'] },
      { output_type: 'error', ename: 'KeyError', evalue: 'k' },
      { output_type: 'stream', name: 'stdout', text: 'y'.repeat(MAX_OUTPUT_CHARS + 10) },
    ] }]));
    const [warn, error, bare, long] = parsed.cells[0]!.outputs;
    expect(warn).toEqual({ kind: 'text', text: 'warn\n', tone: 'stderr' });
    expect(error).toEqual({ kind: 'error', text: 'ValueError: bad' });
    expect(bare).toEqual({ kind: 'error', text: 'KeyError: k' });
    expect((long as { text: string }).text).toContain('10 more characters not shown');
  });
  it('skips cells and outputs it does not understand, and refuses what is not a notebook', () => {
    const parsed = parseNotebook(notebook([null, { cell_type: 'weird' }, { cell_type: 'code', source: 7, outputs: [{ output_type: 'nope' }, 'x'] }], {}));
    expect(parsed.cells).toEqual([{ kind: 'code', source: '', outputs: [] }]);
    expect(parsed.language).toBe('python');
    expect(() => parseNotebook('{oops')).toThrow(NotebookError);
    expect(() => parseNotebook('{"worksheets": []}')).toThrow(/no notebook cells/);
  });
  it('strips colour codes', () => {
    expect(stripAnsi('\u001b[1;32mok\u001b[0m')).toBe('ok');
  });
});

describe('markdown for text cells', () => {
  it('splits headings, paragraphs, lists, quotes, code and rules', () => {
    const blocks = parseBlocks('# Title\n\nOne\ntwo\n\n- a\n- b\n\n1. x\n2. y\n\n> quoted\n\n```py\nprint(1)\n```\n\n---');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', text: 'One two' },
      { kind: 'list', ordered: false, items: ['a', 'b'] },
      { kind: 'list', ordered: true, items: ['x', 'y'] },
      { kind: 'quote', text: 'quoted' },
      { kind: 'code', lang: 'py', text: 'print(1)' },
      { kind: 'rule' },
    ]);
  });
  it('finds inline code, emphasis and http links, and leaves anything else as text', () => {
    expect(parseInline('Use `x`, **bold**, *it* and [docs](https://example.com) or [bad](javascript:alert(1))')).toEqual([
      { kind: 'text', text: 'Use ' }, { kind: 'code', text: 'x' }, { kind: 'text', text: ', ' }, { kind: 'strong', text: 'bold' },
      { kind: 'text', text: ', ' }, { kind: 'em', text: 'it' }, { kind: 'text', text: ' and ' },
      { kind: 'link', text: 'docs', href: 'https://example.com' }, { kind: 'text', text: ' or [bad](javascript:alert(1))' },
    ]);
  });
});
